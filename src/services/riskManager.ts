import fs from 'fs';
import nodePath from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { setPaused } from '../state';
import { sendWebhook } from './webhook';

// -----------------------------------------------------------
// Risk Manager — PnL diario realizado + Circuit Breaker
// -----------------------------------------------------------
// Lleva la contabilidad REAL del día (SOL recibido - SOL gastado)
// y pausa el bot automáticamente si:
//   - la pérdida diaria supera MAX_DAILY_LOSS_SOL, o
//   - hay MAX_CONSECUTIVE_LOSSES pérdidas seguidas.
// El usuario reanuda manualmente vía POST /api/toggle-pause.
// -----------------------------------------------------------

export interface DailyStats {
  /** Fecha UTC (YYYY-MM-DD) a la que pertenecen las métricas */
  date: string;
  /** PnL realizado acumulado del día en SOL */
  realizedPnlSol: number;
  trades: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  breakerTripped: boolean;
  breakerReason?: string;
}

const STATS_FILE = nodePath.join(process.cwd(), 'data', 'stats.json');

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function freshStats(): DailyStats {
  return {
    date: todayUtc(),
    realizedPnlSol: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    breakerTripped: false,
  };
}

let stats: DailyStats = freshStats();

function saveStats(): void {
  try {
    const dir = nodePath.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  No se pudo guardar stats.json');
  }
}

/** Reinicia las métricas si cambió el día UTC y emite el resumen del día */
function rolloverIfNeeded(): void {
  if (stats.date === todayUtc()) return;
  const prev = { ...stats };
  logger.info(
    {
      date: prev.date,
      realizedPnlSol: prev.realizedPnlSol.toFixed(6),
      trades: prev.trades,
      wins: prev.wins,
      losses: prev.losses,
    },
    '📅 Cierre de día — reiniciando métricas diarias',
  );
  stats = freshStats();
  saveStats();

  // Resumen diario hacia n8n (→ Telegram/email) — solo si hubo actividad
  if (prev.trades > 0) {
    void sendWebhook({
      event: 'DAILY_SUMMARY',
      mint: 'SYSTEM',
      realizedPnlSol: parseFloat(prev.realizedPnlSol.toFixed(6)),
      timestamp: Date.now(),
      extra: {
        date: prev.date,
        trades: prev.trades,
        wins: prev.wins,
        losses: prev.losses,
        winRate: prev.trades > 0 ? parseFloat(((prev.wins / prev.trades) * 100).toFixed(1)) : 0,
        breakerTripped: prev.breakerTripped,
      },
    });
  }
}

export function initRiskManager(): void {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) as DailyStats;
      if (loaded && typeof loaded.date === 'string') stats = { ...freshStats(), ...loaded };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, '⚠️  No se pudo leer stats.json — empezando desde cero');
  }
  rolloverIfNeeded();
  if (stats.breakerTripped) {
    setPaused(true);
    logger.warn(
      { reason: stats.breakerReason },
      '🛑 Circuit breaker seguía activo al arrancar — bot en pausa',
    );
  }
  logger.info(
    {
      realizedPnlSol: stats.realizedPnlSol.toFixed(6),
      trades: stats.trades,
      maxDailyLoss: config.MAX_DAILY_LOSS_SOL,
      maxConsecutiveLosses: config.MAX_CONSECUTIVE_LOSSES,
    },
    '🛡️  Risk manager inicializado',
  );
}

/**
 * Registra el resultado REAL de una posición cerrada y evalúa
 * si hay que disparar el circuit breaker.
 */
export function recordClosedTrade(info: {
  mint: string;
  symbol: string;
  pnlSol: number;
  solSpent: number;
}): void {
  rolloverIfNeeded();

  stats.trades++;
  stats.realizedPnlSol += info.pnlSol;
  if (info.pnlSol < 0) {
    stats.losses++;
    stats.consecutiveLosses++;
  } else {
    stats.wins++;
    stats.consecutiveLosses = 0;
  }
  saveStats();

  logger.info(
    {
      mint: info.mint,
      symbol: info.symbol,
      tradePnlSol: info.pnlSol.toFixed(6),
      dailyPnlSol: stats.realizedPnlSol.toFixed(6),
      winRate: stats.trades > 0 ? `${((stats.wins / stats.trades) * 100).toFixed(0)}%` : '-',
      consecutiveLosses: stats.consecutiveLosses,
    },
    '📊 PnL diario actualizado',
  );

  maybeTripBreaker();
}

function maybeTripBreaker(): void {
  if (stats.breakerTripped) return;

  let reason: string | null = null;
  if (
    config.MAX_DAILY_LOSS_SOL > 0 &&
    stats.realizedPnlSol <= -config.MAX_DAILY_LOSS_SOL
  ) {
    reason = `Pérdida diaria ${stats.realizedPnlSol.toFixed(4)} SOL alcanzó el límite de -${config.MAX_DAILY_LOSS_SOL} SOL`;
  } else if (
    config.MAX_CONSECUTIVE_LOSSES > 0 &&
    stats.consecutiveLosses >= config.MAX_CONSECUTIVE_LOSSES &&
    stats.realizedPnlSol < 0
  ) {
    // Solo frena por racha si el día va en rojo — una racha de pérdidas
    // pequeñas en un día ganador es varianza normal, no una emergencia
    reason = `${stats.consecutiveLosses} pérdidas consecutivas con día en negativo (${stats.realizedPnlSol.toFixed(4)} SOL)`;
  }
  if (!reason) return;

  stats.breakerTripped = true;
  stats.breakerReason = reason;
  setPaused(true);
  saveStats();

  logger.error(
    { reason, dailyPnlSol: stats.realizedPnlSol.toFixed(6) },
    '🛑 CIRCUIT BREAKER DISPARADO — bot pausado (reanudar con /api/toggle-pause)',
  );

  void sendWebhook({
    event: 'CIRCUIT_BREAKER_TRIGGERED',
    mint: 'SYSTEM',
    error: reason,
    realizedPnlSol: parseFloat(stats.realizedPnlSol.toFixed(6)),
    timestamp: Date.now(),
  });
}

export function getDailyStats(): DailyStats {
  rolloverIfNeeded();
  return { ...stats };
}

/**
 * Re-arma el circuit breaker tras una reanudación manual.
 * Sin esto, un breaker disparado deja al bot SIN protección el resto
 * del día (maybeTripBreaker ignora todo mientras breakerTripped=true).
 */
export function resetBreaker(): void {
  rolloverIfNeeded();
  if (!stats.breakerTripped && stats.consecutiveLosses === 0) return;
  stats.breakerTripped = false;
  stats.breakerReason = undefined;
  stats.consecutiveLosses = 0;
  saveStats();
  logger.info('🔄 Circuit breaker re-armado tras reanudación manual');
}
