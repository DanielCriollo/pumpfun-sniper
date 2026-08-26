import fs from 'fs';
import nodePath from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { Position, TradeEvent, TradeRecord, WebhookEvent } from '../types';
import { sellToken, SellResult } from './pumpfun';
import { getTokenDisplayBalance, reclaimAtaRent, wallet } from './solana';
import { subscribeToMintTrades, unsubscribeMintTrades } from '../state';
import { PublicKey } from '@solana/web3.js';
import { sendWebhook } from './webhook';
import { recordClosedTrade } from './riskManager';

// -----------------------------------------------------------
// Gestor Algorítmico de Posiciones — Módulo C
// Incluye: TP% basado en ganancia, Trailing SL con HWM,
//          salida por tiempo y por dev-sell, PnL realizado REAL,
//          persistencia en disco + historial, y detección de
//          ventas externas (Phantom).
// -----------------------------------------------------------

/** Mapa mint → Position ACTIVA (fuente de verdad en memoria).
 *  Las cerradas se mueven al historial en disco y salen del mapa. */
const positions = new Map<string, Position>();

/** Set de mints en proceso de venta activo — evita doble venta concurrente */
const sellLocks = new Set<string>();

/** Firmas de ventas ejecutadas por el bot — para ignorar su eco en el WS
 *  y no confundirlas con ventas externas (Phantom) */
const ownSellSignatures = new Set<string>();
const OWN_SIG_TTL_MS = 5 * 60_000;

/** Timestamps de trades recientes por mint — detección de muerte de volumen */
const tradeTimes = new Map<string, number[]>();

/** Escalado de slippage en salidas defensivas: si la venta falla mientras
 *  el precio se derrumba, salir importa más que el precio */
const ESCALATION_SLIPPAGES = [25, 50, 99];
const DEFENSIVE_EVENTS: WebhookEvent[] = [
  'SL_TRIGGERED',
  'DEV_SELL_EXIT',
  'POSITION_CLOSED_TIME_EXPIRED',
  'VOLUME_DEATH_EXIT',
  'PANIC_SELL',
];

const DATA_DIR = nodePath.join(process.cwd(), 'data');
const POSITIONS_FILE = nodePath.join(DATA_DIR, 'positions.json');
const HISTORY_FILE = nodePath.join(DATA_DIR, 'closed-positions.jsonl');

// -----------------------------------------------------------
// Persistencia en disco
// -----------------------------------------------------------

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function savePositions(): void {
  try {
    ensureDataDir();
    const data = JSON.stringify(Array.from(positions.values()), null, 2);
    fs.writeFileSync(POSITIONS_FILE, data, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  No se pudo guardar positions.json');
  }
}

/** Historial de posiciones cerradas — una línea JSON por posición (JSONL) */
function appendToHistory(position: Position): void {
  try {
    ensureDataDir();
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(position) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  No se pudo escribir en el historial');
  }
}

function loadPositions(): void {
  try {
    if (!fs.existsSync(POSITIONS_FILE)) return;
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf8');
    const arr = JSON.parse(raw) as Position[];
    let active = 0;
    for (const pos of arr) {
      // Solo las activas viven en memoria; las cerradas van al historial
      if (pos.status !== 'ACTIVE') continue;
      pos.solReceived = pos.solReceived ?? 0;
      positions.set(pos.mint, pos);
      active++;
    }
    logger.info({ active }, '💾 Posiciones activas cargadas desde disco');
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
    subscribeToMintTrades(pos.mint);
    resubscribed++;
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
  position.solReceived = position.solReceived ?? 0;
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
// Cierre centralizado — TODA salida definitiva pasa por aquí
// -----------------------------------------------------------

/**
 * Marca la posición como cerrada, calcula el PnL realizado REAL,
 * lo registra en el risk manager (circuit breaker), archiva la
 * posición en el historial, se desuscribe del mint y recupera
 * la renta de la ATA. Devuelve el PnL realizado en SOL.
 */
function closePosition(position: Position): number {
  position.status = 'CLOSED';
  const realized = (position.solReceived ?? 0) - position.solSpent;
  position.realizedPnlSol = realized;

  tradeTimes.delete(position.mint);
  unsubscribeMintTrades(position.mint);
  appendToHistory(position);
  positions.delete(position.mint);
  savePositions();

  recordClosedTrade({
    mint: position.mint,
    symbol: position.symbol,
    pnlSol: realized,
    solSpent: position.solSpent,
  });

  void reclaimAtaRent(new PublicKey(position.mint));
  return realized;
}

// -----------------------------------------------------------
// Procesamiento de eventos de trade
// -----------------------------------------------------------

/**
 * Actualiza el market cap actual de la posición y evalúa TP/SL.
 * También detecta dev-sells (señal de rug) y ventas realizadas
 * externamente (Phantom u otro wallet).
 */
export async function processTradeEvent(event: TradeEvent): Promise<void> {
  const position = positions.get(event.mint);
  if (!position || position.status !== 'ACTIVE') return;

  // Actualizar market cap en tiempo real
  position.currentMarketCapSol = event.marketCapSol;

  // Registrar actividad para la detección de muerte de volumen
  if (config.VOLUME_EXIT_MIN_TRADES > 0) {
    const times = tradeTimes.get(event.mint) ?? [];
    times.push(Date.now());
    // Mantener solo lo relevante para la ventana (x2 de margen)
    const cutoff = Date.now() - config.VOLUME_EXIT_WINDOW_SEC * 2000;
    tradeTimes.set(event.mint, times.filter((t) => t >= cutoff));
  }

  const isOwnWallet = event.traderPublicKey === wallet.publicKey.toBase58();

  if (isOwnWallet && event.txType === 'sell') {
    // Eco de una venta ejecutada por el propio bot: la contabilidad
    // ya la hizo executeSell — ignorar para no cerrarla como "externa".
    if (sellLocks.has(event.mint) || ownSellSignatures.has(event.signature)) {
      return;
    }

    // -----------------------------------------------------------------
    // Venta externa real (Phantom / manual) — sincronizar y contabilizar
    // -----------------------------------------------------------------
    const prevBalance = position.tokenBalance;
    const newBalance = event.newTokenBalance ?? 0;
    position.tokenBalance = newBalance;
    position.solReceived = (position.solReceived ?? 0) + event.solAmount;

    logger.info(
      { mint: event.mint, symbol: position.symbol, prevBalance, newBalance, solReceived: event.solAmount },
      '📱 Venta externa detectada (Phantom/manual)',
    );

    if (newBalance < 1) {
      position.tokenBalance = 0;
      position.exitEvent = 'POSITION_CLOSED_EXTERNAL';
      const realized = closePosition(position);
      const pnlPercent =
        position.solSpent > 0 ? (realized / position.solSpent) * 100 : 0;

      logger.info(
        { mint: event.mint, symbol: position.symbol, realizedPnlSol: realized.toFixed(6) },
        '✅ Posición cerrada por venta externa',
      );

      await sendWebhook({
        event: 'POSITION_CLOSED_EXTERNAL',
        mint: position.mint,
        name: position.name,
        symbol: position.symbol,
        marketCapSol: position.currentMarketCapSol,
        pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        realizedPnlSol: parseFloat(realized.toFixed(6)),
        timestamp: Date.now(),
        position: {
          entryMarketCapSol: position.entryMarketCapSol,
          currentMarketCapSol: position.currentMarketCapSol,
          tokenBalance: 0,
          status: 'CLOSED',
        },
      });
    } else {
      savePositions();
    }
    return;
  }

  // -----------------------------------------------------------------
  // Dev vendiendo con posición abierta = señal de rug → salir YA
  // -----------------------------------------------------------------
  if (
    event.txType === 'sell' &&
    position.creator !== undefined &&
    event.traderPublicKey === position.creator &&
    !sellLocks.has(event.mint)
  ) {
    logger.warn(
      { mint: event.mint, symbol: position.symbol, devSoldSol: event.solAmount },
      '🚨 DEV VENDIENDO — salida inmediata de la posición',
    );
    await executeSell(
      position,
      position.tokenBalance,
      'DEV_SELL_EXIT',
      `Dev vendió ${event.solAmount.toFixed(3)} SOL — salida defensiva`,
    );
    return;
  }

  // Actualizar High Water Mark y recalcular trailing SL
  updateTrailingSLPhases(position);

  // Evaluar condiciones de salida
  await evaluateTpSl(position);
}

// -----------------------------------------------------------
// Trailing Stop Loss — actualización de fases y HWM
// -----------------------------------------------------------

export function updateTrailingSLPhases(position: Position): void {
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
// Lógica TP/SL — evaluación en cada tick de precio y en el monitor
// -----------------------------------------------------------

export interface ExitDecision {
  event: WebhookEvent;
  tokenAmount: number;
  reason: string;
}

/**
 * Decisión de salida PURA (sin I/O): dado el estado de la posición,
 * devuelve qué venta corresponde o null si no toca vender.
 * Separada de evaluateTpSl para poder testearla con secuencias
 * de precios simuladas sin red ni disco.
 */
export function decideExit(position: Position): ExitDecision | null {
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
    return {
      event: 'SL_TRIGGERED',
      tokenAmount: position.tokenBalance,
      reason: `${slLabel} @ ${current.toFixed(4)} SOL mcap (umbral: ${slThreshold.toFixed(4)})`,
    };
  }

  if (!position.tp2Hit && gainPercent >= config.TP2_PERCENT) {
    const sellAmount = Math.floor(
      position.initialTokenBalance * (config.TP2_SELL_PERCENT / 100),
    );
    if (sellAmount > 0 && position.tokenBalance >= sellAmount) {
      return {
        event: 'TP2_TRIGGERED',
        tokenAmount: sellAmount,
        reason: `TP2 @ +${gainPercent.toFixed(1)}% ganancia (${current.toFixed(4)} SOL mcap)`,
      };
    }
    return null;
  }

  if (!position.tp1Hit && gainPercent >= config.TP1_PERCENT) {
    const sellAmount = Math.floor(
      position.initialTokenBalance * (config.TP1_SELL_PERCENT / 100),
    );
    if (sellAmount > 0 && position.tokenBalance >= sellAmount) {
      return {
        event: 'TP1_TRIGGERED',
        tokenAmount: sellAmount,
        reason: `TP1 @ +${gainPercent.toFixed(1)}% ganancia (${current.toFixed(4)} SOL mcap)`,
      };
    }
    return null;
  }

  return null;
}

async function evaluateTpSl(position: Position): Promise<void> {
  if (sellLocks.has(position.mint)) return;
  if (position.tokenBalance < 1) return; // nada que vender aún (balance en recuperación)

  const decision = decideExit(position);
  if (decision) {
    await executeSell(position, decision.tokenAmount, decision.event, decision.reason);
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

  // Sin tokens que vender (p. ej. balance nunca recuperado) → cierre contable
  if (tokenAmount < 1) {
    logger.warn(
      { mint: position.mint, event, tokenAmount },
      '⚠️  Cierre sin venta: balance < 1 token',
    );
    position.exitEvent = event;
    const realized = closePosition(position);
    await sendWebhook({
      event,
      mint: position.mint,
      name: position.name,
      symbol: position.symbol,
      marketCapSol: position.currentMarketCapSol,
      realizedPnlSol: parseFloat(realized.toFixed(6)),
      error: 'Cerrada sin venta: balance de tokens < 1',
      timestamp: Date.now(),
    });
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
    // Salidas defensivas: si la venta falla (el precio cae más rápido que el
    // slippage), reintentar escalando slippage — salir importa más que el precio
    const isDefensive = DEFENSIVE_EVENTS.includes(event);
    let result: SellResult | null = null;
    let lastError: unknown = null;
    const slippagePlan = isDefensive
      ? [config.SLIPPAGE_PERCENT, ...ESCALATION_SLIPPAGES.filter((s) => s > config.SLIPPAGE_PERCENT)]
      : [config.SLIPPAGE_PERCENT];

    // Si se vende todo el balance, usar "100%" para no dejar polvo
    const isFullSell = tokenAmount >= position.tokenBalance;

    for (const slippage of slippagePlan) {
      try {
        result = await sellToken(position.mint, tokenAmount, {
          slippagePercent: slippage,
          simMcapSol: position.currentMarketCapSol,
          sellAll: isFullSell,
        });
        break;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { mint: position.mint, slippage, err: msg },
          isDefensive
            ? '⚠️  Venta defensiva fallida — escalando slippage'
            : '⚠️  Venta fallida',
        );
      }
    }
    if (!result) throw lastError;

    // Registrar la firma propia para ignorar su eco en el WS
    ownSellSignatures.add(result.signature);
    setTimeout(() => ownSellSignatures.delete(result.signature), OWN_SIG_TTL_MS).unref();

    // Contabilidad REAL: SOL neto recibido en esta venta
    position.solReceived = (position.solReceived ?? 0) + result.solReceived;

    const record: TradeRecord = {
      timestamp: Date.now(),
      action: 'SELL',
      tokenAmount: result.tokensSold,
      solAmount: result.solReceived,
      marketCapSol: position.currentMarketCapSol,
      signature: result.signature,
      reason,
    };
    position.trades.push(record);

    position.tokenBalance = Math.max(0, position.tokenBalance - result.tokensSold);

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
      // SL / panic / time-exit / dev-sell → salida total
      position.tokenBalance = 0;
    }

    const isFullExit = position.tokenBalance < 1;
    let realized: number | undefined;
    if (isFullExit) {
      position.exitEvent = event;
      realized = closePosition(position);
    } else {
      savePositions();
    }

    const totalReceived = position.solReceived ?? 0;
    const realizedSoFar = totalReceived - position.solSpent;
    const pnlPercent =
      position.solSpent > 0 && isFullExit
        ? (realizedSoFar / position.solSpent) * 100
        : ((position.currentMarketCapSol - position.entryMarketCapSol) /
            position.entryMarketCapSol) *
          100;

    logger.info(
      {
        mint: position.mint,
        signature: result.signature,
        newBalance: position.tokenBalance,
        solReceivedNow: result.solReceived.toFixed(6),
        realizedPnlSol: realizedSoFar.toFixed(6),
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
      tokenAmount: result.tokensSold,
      solAmount: result.solReceived,
      signature: result.signature,
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
      realizedPnlSol: parseFloat((realized ?? realizedSoFar).toFixed(6)),
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
// Monitor de posiciones — corre cada 10 s
//   1. Evalúa TP/SL aunque NO lleguen trades (tokens muertos)
//   2. Recupera balances que quedaron en 0 tras la compra
//   3. Cierra posiciones zombie por tiempo máximo
// -----------------------------------------------------------

const MONITOR_INTERVAL_MS = 10_000;

/** Reintenta leer el balance real de posiciones registradas con balance 0 */
async function recoverMissingBalance(position: Position): Promise<void> {
  if (config.DRY_RUN) return; // en paper trading el balance simulado siempre existe
  try {
    const bal = await getTokenDisplayBalance(new PublicKey(position.mint));
    if (bal < 1) return;

    position.tokenBalance = bal;
    position.initialTokenBalance = bal;
    // Con el balance real ya se puede calcular la entrada REAL del fill
    const entry = (position.solSpent / bal) * config.PUMP_TOTAL_SUPPLY;
    position.entryMarketCapSol = entry;
    position.highWaterMarkMcap = Math.max(position.highWaterMarkMcap ?? 0, entry);
    if (!position.breakevenActive && !position.trailingSLActive) {
      position.effectiveSLThreshold = entry * (1 - config.SL_PERCENT / 100);
    }
    savePositions();
    logger.info(
      { mint: position.mint, balance: bal, entryMcap: entry.toFixed(4) },
      '🔧 Balance recuperado — posición ahora vendible',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug({ mint: position.mint, err: msg }, 'Recuperación de balance fallida — se reintentará');
  }
}

async function monitorTick(): Promise<void> {
  const now = Date.now();
  const maxMs = config.MAX_HOLD_MINUTES * 60_000;

  for (const position of Array.from(positions.values())) {
    if (position.status !== 'ACTIVE') continue;
    if (sellLocks.has(position.mint)) continue;

    // 1. Recuperar balance 0 (compra confirmada pero RPC no propagó a tiempo)
    if (position.tokenBalance < 1 && position.initialTokenBalance < 1) {
      await recoverMissingBalance(position);
    }

    // 2. Evaluar SL/TP sin depender de que alguien tradee el token
    if (position.tokenBalance >= 1) {
      updateTrailingSLPhases(position);
      await evaluateTpSl(position);
      if (position.status !== 'ACTIVE' || sellLocks.has(position.mint)) continue;
    }

    const holdMs = now - position.entryTimestamp;

    // 3. Muerte de volumen: si nadie tradea el token, el momentum murió —
    //    salir ya (aunque se esté en verde), porque la liquidez se evapora
    if (
      config.VOLUME_EXIT_MIN_TRADES > 0 &&
      position.tokenBalance >= 1 &&
      holdMs > Math.max(60_000, config.VOLUME_EXIT_WINDOW_SEC * 1000)
    ) {
      const cutoff = now - config.VOLUME_EXIT_WINDOW_SEC * 1000;
      const recentTrades = (tradeTimes.get(position.mint) ?? []).filter((t) => t >= cutoff);
      if (recentTrades.length < config.VOLUME_EXIT_MIN_TRADES) {
        logger.warn(
          {
            mint: position.mint,
            symbol: position.symbol,
            tradesInWindow: recentTrades.length,
            windowSec: config.VOLUME_EXIT_WINDOW_SEC,
          },
          '📉 Volumen muerto — saliendo de la posición',
        );
        await executeSell(
          position,
          position.tokenBalance,
          'VOLUME_DEATH_EXIT',
          `Solo ${recentTrades.length} trades en ${config.VOLUME_EXIT_WINDOW_SEC}s (mín. ${config.VOLUME_EXIT_MIN_TRADES}) — momentum muerto`,
        );
        continue;
      }
    }

    // 4. Cierre por tiempo máximo (posición zombie)
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

    await executeSell(
      position,
      position.tokenBalance,
      'POSITION_CLOSED_TIME_EXPIRED',
      `Time-based exit: posición abierta ${holdMin} min (límite: ${config.MAX_HOLD_MINUTES} min)`,
    );
  }
}

export function startPositionMonitor(): void {
  setInterval(() => {
    void monitorTick().catch((err) => {
      logger.error({ err }, 'Error en monitorTick');
    });
  }, MONITOR_INTERVAL_MS);

  logger.info(
    { checkIntervalSec: MONITOR_INTERVAL_MS / 1000, maxHoldMin: config.MAX_HOLD_MINUTES },
    '⏱️  Monitor de posiciones iniciado (TP/SL + balance + tiempo)',
  );
}
