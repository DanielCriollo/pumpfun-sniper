import { config } from '../config';
import { logger } from '../logger';
import { Position, TradeEvent, TradeRecord, WebhookEvent } from '../types';
import { sellToken } from './pumpfun';
import { reclaimAtaRent } from './solana';
import { PublicKey } from '@solana/web3.js';
import { sendWebhook } from './webhook';

// -----------------------------------------------------------
// Gestor Algorítmico de Posiciones — Módulo C
// Incluye: TP% basado en ganancia, Trailing SL con HWM,
//          y salida automática por tiempo (posiciones zombie).
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
// Creación de posición — inicializa campos de trailing SL
// -----------------------------------------------------------

export function addPosition(position: Position): void {
  // Inicializar estado del trailing SL
  position.highWaterMarkMcap = position.entryMarketCapSol;
  position.breakevenActive = false;
  position.trailingSLActive = false;
  // SL inicial: entry * (1 - SL_PERCENT / 100)
  position.effectiveSLThreshold =
    position.entryMarketCapSol * (1 - config.SL_PERCENT / 100);

  positions.set(position.mint, position);
  logger.info(
    {
      mint: position.mint,
      name: position.name,
      entryMcap: position.entryMarketCapSol,
      tokenBalance: position.tokenBalance,
      initialSLThreshold: position.effectiveSLThreshold.toFixed(4),
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

  // Actualizar High Water Mark y recalcular trailing SL
  updateTrailingSLPhases(position);

  // Evaluar condiciones de salida
  await evaluateTpSl(position);
}

// -----------------------------------------------------------
// Trailing Stop Loss — actualización de fases y HWM
// -----------------------------------------------------------

/**
 * Recalcula el effectiveSLThreshold según la fase actual:
 *
 *  Fase 0 (inicial):   SL fijo = entry * (1 - SL_PERCENT%)
 *  Fase 1 (breakeven): Si gain >= TRAILING_SL_BREAKEVEN_PERCENT%
 *                      → SL sube a entry (sin pérdida)
 *  Fase 2 (trailing):  Si gain >= TRAILING_SL_ACTIVATE_PERCENT%
 *                      → SL = HWM * (1 - TRAILING_SL_DISTANCE_PERCENT%)
 *                         y se actualiza con cada nuevo HWM
 */
function updateTrailingSLPhases(position: Position): void {
  const entry = position.entryMarketCapSol;
  const current = position.currentMarketCapSol;
  const gainPercent = ((current - entry) / entry) * 100;

  // Actualizar HWM si el precio está subiendo
  if (current > (position.highWaterMarkMcap ?? entry)) {
    position.highWaterMarkMcap = current;
  }

  const hwm = position.highWaterMarkMcap ?? entry;

  if (gainPercent >= config.TRAILING_SL_ACTIVATE_PERCENT) {
    // Fase 2: trailing SL activo — seguir el HWM hacia arriba
    position.trailingSLActive = true;
    position.breakevenActive = true;
    const trailThreshold = hwm * (1 - config.TRAILING_SL_DISTANCE_PERCENT / 100);
    // El trailing SL solo sube, nunca baja
    if (
      position.effectiveSLThreshold === undefined ||
      trailThreshold > position.effectiveSLThreshold
    ) {
      position.effectiveSLThreshold = trailThreshold;
      logger.debug(
        {
          mint: position.mint,
          hwm: hwm.toFixed(4),
          newSL: trailThreshold.toFixed(4),
          gainPercent: gainPercent.toFixed(1),
        },
        '📈 Trailing SL actualizado',
      );
    }
  } else if (gainPercent >= config.TRAILING_SL_BREAKEVEN_PERCENT) {
    // Fase 1: SL sube a breakeven (entry)
    if (!position.breakevenActive) {
      position.breakevenActive = true;
      position.effectiveSLThreshold = entry; // SL = precio de entrada
      logger.info(
        {
          mint: position.mint,
          gainPercent: gainPercent.toFixed(1),
          slThreshold: entry.toFixed(4),
        },
        '🔒 SL movido a breakeven',
      );
    }
  }
  // Si gain < TRAILING_SL_BREAKEVEN_PERCENT: mantener SL fijo inicial
}

// -----------------------------------------------------------
// Lógica TP/SL — evaluación en cada tick de precio
// -----------------------------------------------------------

async function evaluateTpSl(position: Position): Promise<void> {
  // Bloqueo para evitar ventas concurrentes
  if (sellLocks.has(position.mint)) return;

  const entry = position.entryMarketCapSol;
  const current = position.currentMarketCapSol;
  const gainPercent = ((current - entry) / entry) * 100;

  // Umbral de SL efectivo (puede ser fijo, breakeven o trailing)
  const slThreshold =
    position.effectiveSLThreshold ?? entry * (1 - config.SL_PERCENT / 100);

  // ----- Stop Loss (máxima prioridad) -----
  if (current <= slThreshold) {
    const slLabel = position.trailingSLActive
      ? 'Trailing SL'
      : position.breakevenActive
        ? 'Breakeven SL'
        : 'SL fijo';
    await executeSell(
      position,
      position.tokenBalance,
      'SL_TRIGGERED',
      `${slLabel} @ ${current.toFixed(4)} SOL mcap (umbral: ${slThreshold.toFixed(4)})`,
    );
    return;
  }

  // ----- TP2 (antes que TP1 si ambos se disparan a la vez) -----
  if (!position.tp2Hit && gainPercent >= config.TP2_PERCENT) {
    const sellAmount = Math.floor(
      position.initialTokenBalance * (config.TP2_SELL_PERCENT / 100),
    );
    if (sellAmount > 0 && position.tokenBalance >= sellAmount) {
      await executeSell(
        position,
        sellAmount,
        'TP2_TRIGGERED',
        `TP2 @ +${gainPercent.toFixed(1)}% ganancia (${current.toFixed(4)} SOL mcap)`,
      );
    }
    return;
  }

  // ----- TP1 -----
  if (!position.tp1Hit && gainPercent >= config.TP1_PERCENT) {
    const sellAmount = Math.floor(
      position.initialTokenBalance * (config.TP1_SELL_PERCENT / 100),
    );
    if (sellAmount > 0 && position.tokenBalance >= sellAmount) {
      await executeSell(
        position,
        sellAmount,
        'TP1_TRIGGERED',
        `TP1 @ +${gainPercent.toFixed(1)}% ganancia (${current.toFixed(4)} SOL mcap)`,
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

    // Calcular PnL estimado en %
    const pnlPercent =
      ((position.currentMarketCapSol - position.entryMarketCapSol) /
        position.entryMarketCapSol) *
      100;

    // Registrar el trade
    const record: TradeRecord = {
      timestamp: Date.now(),
      action: 'SELL',
      tokenAmount,
      solAmount: 0,
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
      // SL, Panic o Time Expired: cerrar posición
      position.status = 'CLOSED';
      position.tokenBalance = 0;
      // Reclamar rent de la ATA vacía (fire-and-forget)
      void reclaimAtaRent(new PublicKey(position.mint));
    }

    // Si tras la venta no queda balance relevante (dust), cerrar
    if (position.tokenBalance < 1) {
      position.status = 'CLOSED';
      void reclaimAtaRent(new PublicKey(position.mint));
    }

    logger.info(
      {
        mint: position.mint,
        signature: result.signature,
        newBalance: position.tokenBalance,
        pnlPercent: pnlPercent.toFixed(2) + '%',
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
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
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

// -----------------------------------------------------------
// Monitor de tiempo — cierre automático de posiciones zombie
// -----------------------------------------------------------

/**
 * Inicia un setInterval que revisa cada 60 segundos si alguna
 * posición activa lleva más de MAX_POSITION_HOLD_TIME_MINUTES.
 * Llamar una sola vez desde main().
 */
export function startPositionMonitor(): void {
  const intervalMs = 60_000;
  const maxMs = config.MAX_HOLD_MINUTES * 60_000;

  setInterval(() => {
    const now = Date.now();

    for (const position of positions.values()) {
      if (position.status !== 'ACTIVE') continue;
      if (sellLocks.has(position.mint)) continue;

      const holdMs = now - position.entryTimestamp;
      if (holdMs < maxMs) continue;

      const holdMin = (holdMs / 60_000).toFixed(1);
      logger.warn(
        {
          mint: position.mint,
          symbol: position.symbol,
          holdMinutes: holdMin,
          limit: config.MAX_HOLD_MINUTES,
          tokenBalance: position.tokenBalance,
        },
        `⏰ Posición zombie detectada — cerrando por tiempo (${holdMin} min)`,
      );

      void executeSell(
        position,
        position.tokenBalance,
        'POSITION_CLOSED_TIME_EXPIRED',
        `Time-based exit: posición abierta ${holdMin} min (límite: ${config.MAX_HOLD_MINUTES} min)`,
      );
    }
  }, intervalMs);

  logger.info(
    {
      checkIntervalMin: 1,
      maxHoldMin: config.MAX_HOLD_MINUTES,
    },
    '⏱️  Monitor de tiempo de posiciones iniciado',
  );
}
