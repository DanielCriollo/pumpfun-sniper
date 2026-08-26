import fs from 'fs';
import nodePath from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { Position, TradeEvent, TradeRecord, WebhookEvent } from '../types';
import { sellToken } from './pumpfun';
import { reclaimAtaRent, wallet } from './solana';
import { subscribeToMintTrades } from '../state';
import { PublicKey } from '@solana/web3.js';
import { sendWebhook } from './webhook';

// -----------------------------------------------------------
// Gestor Algorítmico de Posiciones — Módulo C
// Incluye: TP% basado en ganancia, Trailing SL con HWM,
//          salida automática por tiempo, persistencia en disco,
//          y detección de ventas externas (Phantom).
// -----------------------------------------------------------

/** Mapa mint → Position (fuente de verdad en memoria) */
const positions = new Map<string, Position>();

/** Set de mints en proceso de venta activo — evita doble venta concurrente */
const sellLocks = new Set<string>();

/** Ruta del archivo de persistencia */
const POSITIONS_FILE = nodePath.join(process.cwd(), 'data', 'positions.json');

// -----------------------------------------------------------
// Persistencia en disco
// -----------------------------------------------------------

function savePositions(): void {
  try {
    const dir = nodePath.dirname(POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = JSON.stringify(Array.from(positions.values()), null, 2);
    fs.writeFileSync(POSITIONS_FILE, data, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  No se pudo guardar positions.json');
  }
}

function loadPositions(): void {
  try {
    if (!fs.existsSync(POSITIONS_FILE)) return;
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf8');
    const arr = JSON.parse(raw) as Position[];
    for (const pos of arr) {
      positions.set(pos.mint, pos);
    }
    const active = arr.filter((p) => p.status === 'ACTIVE').length;
    logger.info(
      { loaded: arr.length, active },
      '💾 Posiciones cargadas desde disco',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  No se pudo leer positions.json — empezando desde cero');
  }
}

/**
 * Inicializa el gestor: carga posiciones persistidas y re-suscribe
 * a los mints de posiciones activas para seguir monitoreando TP/SL.
 * Llamar una sola vez desde main() antes de conectar el WebSocket.
 */
export function initPositionManager(): void {
  loadPositions();
  let resubscribed = 0;
  for (const pos of positions.values()) {
    if (pos.status === 'ACTIVE') {
      subscribeToMintTrades(pos.mint);
      resubscribed++;
    }
  }
  if (resubscribed > 0) {
    logger.info(
      { resubscribed },
      '🔄 Re-suscrito a mints de posiciones activas tras reinicio',
    );
  }
}

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
  position.highWaterMarkMcap = position.entryMarketCapSol;
  position.breakevenActive = false;
  position.trailingSLActive = false;
  position.effectiveSLThreshold =
    position.entryMarketCapSol * (1 - config.SL_PERCENT / 100);

  positions.set(position.mint, position);
  savePositions();

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
 * También detecta ventas realizadas externamente (Phantom u otro wallet).
 */
export async function processTradeEvent(event: TradeEvent): Promise<void> {
  const position = positions.get(event.mint);
  if (!position || position.status !== 'ACTIVE') return;

  // Actualizar market cap en tiempo real
  position.currentMarketCapSol = event.marketCapSol;

  // -----------------------------------------------------------------
  // Detección de venta externa (Phantom / manual)
  // Si nuestra wallet vendió este token sin que el bot lo ejecutara,
  // sincronizamos el balance y cerramos la posición si es necesario.
  // -----------------------------------------------------------------
  if (
    event.txType === 'sell' &&
    event.traderPublicKey === wallet.publicKey.toBase58()
  ) {
    const prevBalance = position.tokenBalance;
    const newBalance = event.newTokenBalance ?? 0;
    position.tokenBalance = newBalance;

    logger.info(
      {
        mint: event.mint,
        symbol: position.symbol,
        prevBalance,
        newBalance,
      },
      '📱 Venta externa detectada (Phantom/manual)',
    );

    if (newBalance < 1) {
      position.status = 'CLOSED';
      position.tokenBalance = 0;
      void reclaimAtaRent(new PublicKey(position.mint));

      const pnlPercent =
        ((position.currentMarketCapSol - position.entryMarketCapSol) /
          position.entryMarketCapSol) *
        100;

      logger.info(
        {
          mint: event.mint,
          symbol: position.symbol,
          pnlPercent: pnlPercent.toFixed(2) + '%',
        },
        '✅ Posición cerrada por venta externa',
      );

      savePositions();

      await sendWebhook({
        event: 'POSITION_CLOSED_EXTERNAL',
        mint: position.mint,
        name: position.name,
        symbol: position.symbol,
        marketCapSol: position.currentMarketCapSol,
        pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        timestamp: Date.now(),
        position: {
          entryMarketCapSol: position.entryMarketCapSol,
          currentMarketCapSol: position.currentMarketCapSol,
          tokenBalance: 0,
          status: 'CLOSED',
        },
      });
    } else {
      // Venta parcial desde Phantom — actualizar balance y guardar
      savePositions();
    }
    return; // No evaluar TP/SL para trades externos
  }

  // Actualizar High Water Mark y recalcular trailing SL
  updateTrailingSLPhases(position);

  // Evaluar condiciones de salida
  await evaluateTpSl(position);
}

// -----------------------------------------------------------
// Trailing Stop Loss — actualización de fases y HWM
// -----------------------------------------------------------

function updateTrailingSLPhases(position: Position): void {
  const entry = position.entryMarketCapSol;
  const current = position.currentMarketCapSol;
  const gainPercent = ((current - entry) / entry) * 100;
  const holdMin = (Date.now() - position.entryTimestamp) / 60_000;

  // Actualizar High Water Mark
  if (current > (position.highWaterMarkMcap ?? entry)) {
    position.highWaterMarkMcap = current;
  }
  const hwm = position.highWaterMarkMcap ?? entry;

  // Fase 2 — Trailing SL activo: SL = HWM * (1 - TRAILING_SL_DISTANCE_PERCENT%)
  if (gainPercent >= config.TRAILING_SL_ACTIVATE_PERCENT) {
    position.trailingSLActive = true;
    position.breakevenActive = true;
    const trailThreshold = hwm * (1 - config.TRAILING_SL_DISTANCE_PERCENT / 100);
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
    return;
  }

  // Fase 1 — Breakeven: SL sube a precio de entrada
  // Se activa si gain >= TRAILING_SL_BREAKEVEN_PERCENT O si ya se ejecutó TP1
  if (gainPercent >= config.TRAILING_SL_BREAKEVEN_PERCENT || position.tp1Hit) {
    if (!position.breakevenActive) {
      position.breakevenActive = true;
      position.effectiveSLThreshold = Math.max(
        position.effectiveSLThreshold ?? 0,
        entry,
      );
      logger.info(
        {
          mint: position.mint,
          gainPercent: gainPercent.toFixed(1),
          slThreshold: entry.toFixed(4),
          trigger: position.tp1Hit ? 'TP1 ejecutado' : 'ganancia breakeven',
        },
        '🔒 SL movido a breakeven',
      );
    }
    return;
  }

  // Fase -1 — SL apretado por tiempo: si lleva >= N min sin llegar a TP1,
  // sube el SL de -SL_PERCENT% a -SL_TIGHT_PERCENT% para salir rápido
  if (holdMin >= config.SL_TIGHTEN_AFTER_MINUTES && !position.breakevenActive) {
    const tightThreshold = entry * (1 - config.SL_TIGHT_PERCENT / 100);
    if (
      position.effectiveSLThreshold === undefined ||
      tightThreshold > position.effectiveSLThreshold
    ) {
      position.effectiveSLThreshold = tightThreshold;
      logger.info(
        {
          mint: position.mint,
          holdMin: holdMin.toFixed(1),
          oldSL: (entry * (1 - config.SL_PERCENT / 100)).toFixed(4),
          newSL: tightThreshold.toFixed(4),
        },
        `⏱️  SL apretado por tiempo (${holdMin.toFixed(1)} min sin TP)`,
      );
    }
  }
}

// -----------------------------------------------------------
// Lógica TP/SL — evaluación en cada tick de precio
// -----------------------------------------------------------

async function evaluateTpSl(position: Position): Promise<void> {
  if (sellLocks.has(position.mint)) return;

  const entry = position.entryMarketCapSol;
  const current = position.currentMarketCapSol;
  const gainPercent = ((current - entry) / entry) * 100;

  const slThreshold =
    position.effectiveSLThreshold ?? entry * (1 - config.SL_PERCENT / 100);

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
// Ejecutor de ventas (todas las salidas del bot pasan por aquí)
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

    const pnlPercent =
      ((position.currentMarketCapSol - position.entryMarketCapSol) /
        position.entryMarketCapSol) *
      100;

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

    position.tokenBalance = Math.max(0, position.tokenBalance - tokenAmount);

    if (event === 'TP1_TRIGGERED') {
      position.tp1Hit = true;
      // Mover SL a breakeven inmediatamente — el capital inicial ya está asegurado
      if (!position.breakevenActive) {
        position.breakevenActive = true;
        position.effectiveSLThreshold = Math.max(
          position.effectiveSLThreshold ?? 0,
          position.entryMarketCapSol,
        );
        logger.info({ mint: position.mint }, '🔒 SL a breakeven tras TP1 — capital protegido');
      }
    } else if (event === 'TP2_TRIGGERED') {
      position.tp2Hit = true;
    } else {
      position.status = 'CLOSED';
      position.tokenBalance = 0;
      void reclaimAtaRent(new PublicKey(position.mint));
    }

    if (position.tokenBalance < 1) {
      position.status = 'CLOSED';
      void reclaimAtaRent(new PublicKey(position.mint));
    }

    savePositions();

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
  await executeSell(position, position.tokenBalance, 'PANIC_SELL', 'Panic sell manual');
}

// -----------------------------------------------------------
// Monitor de tiempo — cierre automático de posiciones zombie
// -----------------------------------------------------------

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
    { checkIntervalMin: 1, maxHoldMin: config.MAX_HOLD_MINUTES },
    '⏱️  Monitor de tiempo de posiciones iniciado',
  );
}
