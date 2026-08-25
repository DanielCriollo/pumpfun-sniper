import { config } from '../config';
import { logger } from '../logger';
import { Position, TradeEvent, TradeRecord, WebhookEvent } from '../types';
import { sellToken } from './pumpfun';
import { sendWebhook } from './webhook';

// -----------------------------------------------------------
// Gestor Algorítmico de Posiciones — Módulo C
// -----------------------------------------------------------

/** Mapa mint → Position (fuente de verdad en memoria) */
const positions = new Map<string, Position>();

/**
 * Set de mints en proceso de venta activo.
 * Evita que dos eventos de trade simultáneos disparen
 * una doble venta para la misma posición.
 */
const sellLocks = new Set<string>();

// -----------------------------------------------------------
// Lectura de posiciones
// -----------------------------------------------------------

export function getPosition(mint: string): Position | undefined {
  return positions.get(mint);
}

export function getAllPositions(): Position[] {
  return Array.from(positions.values());
}

export function getActivePositionCount(): number {
  let count = 0;
  for (const p of positions.values()) {
    if (p.status === 'ACTIVE') count++;
  }
  return count;
}

export function hasActivePosition(mint: string): boolean {
  const p = positions.get(mint);
  return p !== undefined && p.status === 'ACTIVE';
}

// -----------------------------------------------------------
// Creación de posición
// -----------------------------------------------------------

export function addPosition(position: Position): void {
  positions.set(position.mint, position);
  logger.info(
    {
      mint: position.mint,
      name: position.name,
      entryMcap: position.entryMarketCapSol,
      tokenBalance: position.tokenBalance,
      totalActive: getActivePositionCount(),
    },
    '📂 Posición abierta',
  );
}

// -----------------------------------------------------------
// Procesamiento de eventos de trade
// -----------------------------------------------------------

/**
 * Actualiza el market cap actual de la posición y evalúa TP/SL.
 * Llamado cada vez que llega un TradeEvent del WebSocket.
 */
export async function processTradeEvent(event: TradeEvent): Promise<void> {
  const position = positions.get(event.mint);
  if (!position || position.status !== 'ACTIVE') return;

  // Actualizar market cap en tiempo real
  position.currentMarketCapSol = event.marketCapSol;

  // Evaluar condiciones de salida
  await evaluateTpSl(position);
}

// -----------------------------------------------------------
// Lógica TP/SL
// -----------------------------------------------------------

async function evaluateTpSl(position: Position): Promise<void> {
  // Bloqueo para evitar ventas concurrentes
  if (sellLocks.has(position.mint)) return;

  const entry = position.entryMarketCapSol;
  const current = position.currentMarketCapSol;
  const multiplier = current / entry; // ej. 2.0 = 2x

  // ----- Stop Loss (máxima prioridad) -----
  // Disparar si cae SL_PERCENT% desde la entrada, sin importar qué TPs se han ejecutado
  const slThreshold = entry * (1 - config.SL_PERCENT / 100);
  if (current <= slThreshold) {
    await executeSell(
      position,
      position.tokenBalance, // 100% de lo que queda
      'SL_TRIGGERED',
      `SL @ ${current.toFixed(4)} SOL mcap (entrada: ${entry.toFixed(4)})`,
    );
    return;
  }

  // ----- TP2 (antes que TP1 si los dos se disparan a la vez) -----
  if (!position.tp2Hit && multiplier >= config.TP2_MULTIPLIER) {
    const sellAmount = Math.floor(
      position.initialTokenBalance * (config.TP2_SELL_PERCENT / 100),
    );
    if (sellAmount > 0 && position.tokenBalance >= sellAmount) {
      await executeSell(
        position,
        sellAmount,
        'TP2_TRIGGERED',
        `TP2 @ ${multiplier.toFixed(2)}x mcap (${current.toFixed(4)} SOL)`,
      );
    }
    return;
  }

  // ----- TP1 -----
  if (!position.tp1Hit && multiplier >= config.TP1_MULTIPLIER) {
    const sellAmount = Math.floor(
      position.initialTokenBalance * (config.TP1_SELL_PERCENT / 100),
    );
    if (sellAmount > 0 && position.tokenBalance >= sellAmount) {
      await executeSell(
        position,
        sellAmount,
        'TP1_TRIGGERED',
        `TP1 @ ${multiplier.toFixed(2)}x mcap (${current.toFixed(4)} SOL)`,
      );
    }
    return;
  }
}

// -----------------------------------------------------------
// Ejecutor de ventas (todas las salidas pasan por aquí)
// -----------------------------------------------------------

async function executeSell(
  position: Position,
  tokenAmount: number,
  event: WebhookEvent,
  reason: string,
): Promise<void> {
  if (sellLocks.has(position.mint)) {
    logger.warn({ mint: position.mint }, 'Venta ignorada: sell lock activo');
    return;
  }

  sellLocks.add(position.mint);
  logger.info(
    {
      mint: position.mint,
      event,
      reason,
      tokenAmount,
      currentMcap: position.currentMarketCapSol,
    },
    `🎯 Disparando ${event}`,
  );

  try {
    const result = await sellToken(position.mint, tokenAmount);

    // Registrar el trade
    const record: TradeRecord = {
      timestamp: Date.now(),
      action: 'SELL',
      tokenAmount,
      solAmount: 0, // No conocemos el SOL exacto hasta consultar la tx
      marketCapSol: position.currentMarketCapSol,
      signature: result.signature,
      reason,
    };
    position.trades.push(record);

    // Actualizar balance y flags
    position.tokenBalance = Math.max(0, position.tokenBalance - tokenAmount);

    if (event === 'TP1_TRIGGERED') {
      position.tp1Hit = true;
    } else if (event === 'TP2_TRIGGERED') {
      position.tp2Hit = true;
    } else {
      // SL o Panic: cerrar posición
      position.status = 'CLOSED';
      position.tokenBalance = 0;
    }

    // Si tras la venta no queda balance relevante (dust), cerrar
    if (position.tokenBalance < 1) {
      position.status = 'CLOSED';
    }

    logger.info(
      {
        mint: position.mint,
        signature: result.signature,
        newBalance: position.tokenBalance,
        status: position.status,
      },
      `✅ ${event} ejecutado`,
    );

    // Notificar a n8n
    await sendWebhook({
      event,
      mint: position.mint,
      name: position.name,
      symbol: position.symbol,
      marketCapSol: position.currentMarketCapSol,
      tokenAmount,
      signature: result.signature,
      timestamp: Date.now(),
      position: {
        entryMarketCapSol: position.entryMarketCapSol,
        currentMarketCapSol: position.currentMarketCapSol,
        tokenBalance: position.tokenBalance,
        tp1Hit: position.tp1Hit,
        tp2Hit: position.tp2Hit,
        status: position.status,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ mint: position.mint, event, err: errMsg }, `Error en ${event}`);

    await sendWebhook({
      event: 'TRADE_ERROR',
      mint: position.mint,
      name: position.name,
      symbol: position.symbol,
      error: errMsg,
      timestamp: Date.now(),
    });
  } finally {
    sellLocks.delete(position.mint);
  }
}

// -----------------------------------------------------------
// Panic Sell — llamado desde el servidor HTTP
// -----------------------------------------------------------

/**
 * Liquida inmediatamente el 100% del balance de `mint`.
 * Usado por el endpoint POST /api/panic-sell/:mint y
 * desde n8n vía Telegram.
 */
export async function executePanicSell(mint: string): Promise<void> {
  const position = positions.get(mint);
  if (!position) {
    throw new Error(`No existe posición activa para mint: ${mint}`);
  }
  if (position.status !== 'ACTIVE') {
    throw new Error(`La posición ${mint} ya está CERRADA`);
  }
  if (position.tokenBalance < 1) {
    throw new Error(`Balance insuficiente para vender: ${position.tokenBalance}`);
  }

  await executeSell(
    position,
    position.tokenBalance,
    'PANIC_SELL',
    'Panic sell manual',
  );
}
