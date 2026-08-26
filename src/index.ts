import WebSocket from 'ws';
import { config } from './config';
import { logger } from './logger';
import {
  state,
  setWsInstance,
  incrementReconnects,
  resetReconnects,
  subscribeToMintTrades,
} from './state';
import { applyFilters } from './services/filters';
import { buyToken } from './services/pumpfun';
import {
  addPosition,
  startPositionMonitor,
  processTradeEvent,
  getActivePositionCount,
  hasActivePosition,
} from './services/positionManager';
import { sendWebhook } from './services/webhook';
import { startServer } from './server';
import { getSolBalance } from './services/solana';
import { NewTokenEvent, TradeEvent, Position } from './types';

// -----------------------------------------------------------
// Entrypoint — Orquestador principal
// -----------------------------------------------------------

// -----------------------------------------------------------
// Handlers de eventos WebSocket
// -----------------------------------------------------------

async function handleNewToken(event: NewTokenEvent): Promise<void> {
  // Respetar modo pausa
  if (state.isPaused) {
    logger.debug({ mint: event.mint }, 'Bot pausado — token ignorado');
    return;
  }

  // Límite de posiciones concurrentes
  if (getActivePositionCount() >= config.MAX_CONCURRENT_POSITIONS) {
    logger.warn(
      { mint: event.mint, active: getActivePositionCount() },
      'Límite de posiciones alcanzado — token ignorado',
    );
    return;
  }

  // Evitar doble compra del mismo mint
  if (hasActivePosition(event.mint)) {
    return;
  }

  logger.info(
    {
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      marketCapSol: event.marketCapSol,
    },
    `🆕 Nuevo token detectado: ${event.symbol}`,
  );

  // Aplicar filtros anti-rug
  const filterResult = await applyFilters(event);
  if (!filterResult.passed) {
    await sendWebhook({
      event: 'FILTER_REJECTED',
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      marketCapSol: event.marketCapSol,
      filterReason: filterResult.reason,
      timestamp: Date.now(),
    });
    return;
  }

  // Ejecutar compra
  try {
    const solBalance = await getSolBalance();
    if (solBalance < config.BUY_AMOUNT_SOL + 0.005) {
      logger.warn(
        { solBalance, required: config.BUY_AMOUNT_SOL },
        '⚠️  Balance insuficiente para comprar',
      );
      return;
    }

    const buyResult = await buyToken(event.mint, config.BUY_AMOUNT_SOL);

    // Crear y registrar la posición
    const tradeRecord = {
      timestamp: Date.now(),
      action: 'BUY' as const,
      tokenAmount: buyResult.tokenBalance,
      solAmount: config.BUY_AMOUNT_SOL,
      marketCapSol: event.marketCapSol,
      signature: buyResult.signature,
      reason: 'Filtros superados — compra inicial',
    };

    const position: Position = {
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      entryMarketCapSol: event.marketCapSol,
      currentMarketCapSol: event.marketCapSol,
      tokenBalance: buyResult.tokenBalance,
      initialTokenBalance: buyResult.tokenBalance,
      solSpent: config.BUY_AMOUNT_SOL,
      entryTimestamp: Date.now(),
      tp1Hit: false,
      tp2Hit: false,
      status: 'ACTIVE',
      bondingCurveKey: event.bondingCurveKey,
      trades: [tradeRecord],
    };

    addPosition(position);

    // Suscribirse a los trades de este mint para monitoreo TP/SL
    subscribeToMintTrades(event.mint);

    // Notificar a n8n
    await sendWebhook({
      event: 'TOKEN_BOUGHT',
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      marketCapSol: event.marketCapSol,
      solAmount: config.BUY_AMOUNT_SOL,
      tokenAmount: buyResult.tokenBalance,
      signature: buyResult.signature,
      timestamp: Date.now(),
      position: {
        entryMarketCapSol: event.marketCapSol,
        tokenBalance: buyResult.tokenBalance,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ mint: event.mint, err: errMsg }, '❌ Error en compra');
    await sendWebhook({
      event: 'TRADE_ERROR',
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      error: errMsg,
      timestamp: Date.now(),
    });
  }
}

async function handleTradeEvent(event: TradeEvent): Promise<void> {
  await processTradeEvent(event);
}

// -----------------------------------------------------------
// Manejo de mensajes WebSocket entrantes
// -----------------------------------------------------------

function onWsMessage(data: WebSocket.RawData): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data.toString()) as Record<string, unknown>;
  } catch {
    logger.warn('Mensaje WS no parseable ignorado');
    return;
  }

  const txType = parsed['txType'];

  if (txType === 'create') {
    // Usar void + IIFE para manejar la promesa sin bloquear el event loop
    void (async () => {
      try {
        await handleNewToken(parsed as unknown as NewTokenEvent);
      } catch (err) {
        logger.error({ err }, 'Error no capturado en handleNewToken');
      }
    })();
  } else if (txType === 'buy' || txType === 'sell') {
    void (async () => {
      try {
        await handleTradeEvent(parsed as unknown as TradeEvent);
      } catch (err) {
        logger.error({ err }, 'Error no capturado en handleTradeEvent');
      }
    })();
  }
  // Ignorar mensajes de tipo desconocido (pings, acks, etc.)
}

// -----------------------------------------------------------
// Reconexión WebSocket con backoff exponencial
// -----------------------------------------------------------

function connectWebSocket(): void {
  if (state.reconnectAttempts >= config.WS_MAX_RECONNECT_ATTEMPTS) {
    logger.fatal(
      { attempts: state.reconnectAttempts },
      '❌ Máximo de intentos de reconexión WS alcanzado. Cerrando proceso.',
    );
    process.exit(1);
  }

  const delay =
    state.reconnectAttempts === 0
      ? 0
      : Math.min(
          config.WS_RECONNECT_DELAY_MS * 2 ** (state.reconnectAttempts - 1),
          60_000, // cap en 60 s
        );

  if (delay > 0) {
    logger.info(
      { attempt: state.reconnectAttempts, delayMs: delay },
      `🔄 Reconectando WebSocket en ${delay / 1000}s…`,
    );
  }

  setTimeout(() => {
    const ws = new WebSocket(config.WS_PUMPFUN_ENDPOINT);
    setWsInstance(ws);

    ws.on('open', () => {
      resetReconnects();
      logger.info('🟢 WebSocket conectado a PumpPortal');

      // Suscribirse a nuevos tokens
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

      // Re-suscribirse a los mints de posiciones activas
      for (const mint of state.subscribedMints) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      }

      logger.info(
        { resubscribedMints: state.subscribedMints.size },
        '📡 Suscripciones enviadas',
      );
    });

    ws.on('message', onWsMessage);

    ws.on('error', (err: Error) => {
      logger.error({ err: err.message }, '⚠️  Error en WebSocket');
    });

    ws.on('close', (code: number, reason: Buffer) => {
      setWsInstance(null);
      logger.warn(
        { code, reason: reason.toString() },
        '🔴 WebSocket desconectado — iniciando reconexión',
      );
      incrementReconnects();
      connectWebSocket();
    });
  }, delay);
}

// -----------------------------------------------------------
// Manejo de señales del sistema para cierre limpio
// -----------------------------------------------------------

function setupGracefulShutdown(): void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '🛑 Señal de cierre recibida — apagando el bot');

    // Cerrar WebSocket limpiamente
    if (state.wsInstance) {
      state.wsInstance.close(1000, 'Shutdown');
    }

    // Dar tiempo a que se completen operaciones en curso
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));

    logger.info('👋 Bot detenido correctamente');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // Capturar promesas no manejadas sin crashear
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '🚨 unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, '🚨 uncaughtException');
    // No cerramos: PM2 reiniciará si es fatal
  });
}

// -----------------------------------------------------------
// main
// -----------------------------------------------------------

async function main(): Promise<void> {
  logger.info('🚀 Iniciando PumpFun Sniper Bot');

  // Montar manejadores de señales
  setupGracefulShutdown();

  // Iniciar API interna (Fastify)
  await startServer();

  // Iniciar monitor de posiciones zombie (time-based exit)
  startPositionMonitor();

  // Conectar WebSocket a PumpPortal
  connectWebSocket();

  logger.info(
    {
      buyAmount: config.BUY_AMOUNT_SOL,
      maxPositions: config.MAX_CONCURRENT_POSITIONS,
      tp1: `+${config.TP1_PERCENT}% → sell ${config.TP1_SELL_PERCENT}%`,
      tp2: `+${config.TP2_PERCENT}% → sell ${config.TP2_SELL_PERCENT}%`,
      sl: `-${config.SL_PERCENT}%`,
    },
    '⚙️  Parámetros de trading',
  );
}

void main();
