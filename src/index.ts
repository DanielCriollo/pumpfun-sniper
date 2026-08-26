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
  initPositionManager,
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
// Guards de concurrencia y deduplicación
// -----------------------------------------------------------

/** Mints cuya compra está actualmente en proceso — previene doble entrada por mint */
const inFlightMints = new Set<string>();
/** Compras actualmente en vuelo (incluye las que están en filtros/fetch) */
let inFlightBuyCount = 0;
/** Mapa símbolo → timestamp de última compra — evita entrar dos veces en el mismo proyecto */
const recentSymbolBuys = new Map<string, number>();
const SYMBOL_COOLDOWN_MS = 30_000; // 30 segundos

// -----------------------------------------------------------
// Handlers de eventos WebSocket
// -----------------------------------------------------------

async function handleNewToken(event: NewTokenEvent): Promise<void> {
  // 1. Respetar modo pausa
  if (state.isPaused) {
    logger.debug({ mint: event.mint }, 'Bot pausado — token ignorado');
    return;
  }

  // 2. Guard atómico: evitar doble procesamiento del mismo mint
  if (inFlightMints.has(event.mint) || hasActivePosition(event.mint)) return;

  // 3. Límite de posiciones: activas + en vuelo (chequeo atómico pre-await)
  const totalActive = getActivePositionCount() + inFlightBuyCount;
  if (totalActive >= config.MAX_CONCURRENT_POSITIONS) {
    logger.warn(
      { mint: event.mint, active: getActivePositionCount(), inFlight: inFlightBuyCount },
      'Límite de posiciones alcanzado — token ignorado',
    );
    return;
  }

  // 4. Guard de símbolo reciente (evita comprar el mismo proyecto varias veces en 30s)
  const symbolKey = event.symbol.toUpperCase();
  const lastSymbolBuy = recentSymbolBuys.get(symbolKey);
  if (lastSymbolBuy && Date.now() - lastSymbolBuy < SYMBOL_COOLDOWN_MS) {
    logger.debug(
      { symbol: event.symbol, mint: event.mint, msSinceLast: Date.now() - lastSymbolBuy },
      '⏳ Símbolo comprado hace <30s — ignorado',
    );
    return;
  }

  // 5. Filtro de market cap de entrada (mcap alto = menor upside potencial)
  if (config.MAX_ENTRY_MCAP_SOL > 0 && event.marketCapSol > config.MAX_ENTRY_MCAP_SOL) {
    logger.debug(
      { mint: event.mint, mcap: event.marketCapSol, max: config.MAX_ENTRY_MCAP_SOL },
      '📉 Market cap inicial demasiado alto — ignorado',
    );
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

  // Reservar slot SINCRÓNICAMENTE antes del primer await — previene la race condition
  inFlightMints.add(event.mint);
  inFlightBuyCount++;

  try {
    // Aplicar filtros anti-rug (incluye fetch de metadatos — operación async)
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

    // Verificar balance antes de comprar
    const solBalance = await getSolBalance();

    // Dynamic position sizing: usa % del SOL libre si DYNAMIC_BUY_PERCENT > 0
    const buyAmount =
      config.DYNAMIC_BUY_PERCENT > 0
        ? Math.max(solBalance * (config.DYNAMIC_BUY_PERCENT / 100), 0.001)
        : config.BUY_AMOUNT_SOL;

    // Reserva mínima de SOL — siempre conservar MIN_SOL_RESERVE para fees
    if (solBalance < buyAmount + config.MIN_SOL_RESERVE) {
      logger.warn(
        { solBalance, required: buyAmount, reserve: config.MIN_SOL_RESERVE },
        '⚠️  Balance insuficiente — reserva mínima protegida',
      );
      return;
    }

    const buyResult = await buyToken(event.mint, buyAmount);

    // Registrar símbolo como comprado (antes de addPosition para proteger contra errores)
    recentSymbolBuys.set(symbolKey, Date.now());

    // Crear y registrar la posición
    const tradeRecord = {
      timestamp: Date.now(),
      action: 'BUY' as const,
      tokenAmount: buyResult.tokenBalance,
      solAmount: buyAmount,
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
      solSpent: buyAmount,
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
      solAmount: buyAmount,
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
  } finally {
    // Siempre liberar el slot, haya compra exitosa o error
    inFlightMints.delete(event.mint);
    inFlightBuyCount--;
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

  // Cargar posiciones persistidas y re-suscribir mints activos
  initPositionManager();

  // Iniciar monitor de posiciones zombie (time-based exit)
  startPositionMonitor();

  // Conectar WebSocket a PumpPortal
  connectWebSocket();

  logger.info(
    {
      buyMode: config.DYNAMIC_BUY_PERCENT > 0 ? `${config.DYNAMIC_BUY_PERCENT}% del balance` : `${config.BUY_AMOUNT_SOL} SOL fijo`,
      maxPositions: config.MAX_CONCURRENT_POSITIONS,
      tp1: `+${config.TP1_PERCENT}% → sell ${config.TP1_SELL_PERCENT}%`,
      tp2: `+${config.TP2_PERCENT}% → sell ${config.TP2_SELL_PERCENT}%`,
      sl: `-${config.SL_PERCENT}%`,
      maxMcapEntry: config.MAX_ENTRY_MCAP_SOL > 0 ? `${config.MAX_ENTRY_MCAP_SOL} SOL` : 'sin límite',
      minSolReserve: `${config.MIN_SOL_RESERVE} SOL`,
    },
    '⚙️  Parámetros de trading',
  );
}

void main();
