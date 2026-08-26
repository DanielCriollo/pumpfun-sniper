import WebSocket from 'ws';
import { config } from './config';
import { logger } from './logger';
import {
  state,
  setWsInstance,
  incrementReconnects,
  resetReconnects,
  markWsMessage,
  subscribeToMintTrades,
  unsubscribeMintTrades,
} from './state';
import {
  applyFilters,
  registerTokenCreation,
  checkCreatorLocal,
  checkCreatorHistory,
  checkHolderConcentration,
  pruneCreatorRegistry,
} from './services/filters';
import { recordFirehose, recordRejection, startRecorder } from './services/recorder';
import { buyToken, BuyResult } from './services/pumpfun';
import {
  addPosition,
  initPositionManager,
  startPositionMonitor,
  processTradeEvent,
  getActivePositionCount,
  hasActivePosition,
} from './services/positionManager';
import {
  observeToken,
  handleObservationTrade,
  ObservationResult,
} from './services/observer';
import { initRiskManager } from './services/riskManager';
import { sendWebhook } from './services/webhook';
import { startServer } from './server';
import { getSolBalance, sweepProfits } from './services/solana';
import { NewTokenEvent, TradeEvent, Position } from './types';

// -----------------------------------------------------------
// Entrypoint — Orquestador principal
// -----------------------------------------------------------

// -----------------------------------------------------------
// Guards de concurrencia y deduplicación
// -----------------------------------------------------------

/** Mints cuya compra está actualmente en proceso — previene doble entrada por mint */
const inFlightMints = new Set<string>();
/** Compras actualmente en vuelo (incluye las que están en filtros/observación) */
let inFlightBuyCount = 0;
/** SOL comprometido en compras en vuelo — evita que compras concurrentes
 *  lean el mismo balance y violen MIN_SOL_RESERVE */
let reservedSol = 0;
/** Mapa símbolo → timestamp de última compra — evita entrar dos veces en el mismo proyecto */
const recentSymbolBuys = new Map<string, number>();
const SYMBOL_COOLDOWN_MS = 30_000; // 30 segundos

// -----------------------------------------------------------
// Handlers de eventos WebSocket
// -----------------------------------------------------------

async function handleNewToken(event: NewTokenEvent): Promise<void> {
  // Algunos eventos `create` llegan sin symbol/name — normalizar para no crashear
  event.symbol = event.symbol ?? '';
  event.name = event.name ?? '';

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
    logger.debug(
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
    recordRejection({
      mint: event.mint,
      symbol: event.symbol,
      reason: `Mcap inicial ${event.marketCapSol.toFixed(1)} SOL > máx ${config.MAX_ENTRY_MCAP_SOL}`,
      mcapSol: event.marketCapSol,
    });
    return;
  }

  // 6. Filtro local de creador en serie (sin costo de red)
  const creatorLocal = checkCreatorLocal(event.traderPublicKey);
  if (!creatorLocal.passed) {
    logger.info(
      { mint: event.mint, reason: creatorLocal.reason },
      '🚫 Filtro RECHAZADO [creatorLocal]',
    );
    recordRejection({
      mint: event.mint,
      symbol: event.symbol,
      reason: creatorLocal.reason ?? 'creador en serie',
      mcapSol: event.marketCapSol,
    });
    await sendWebhook({
      event: 'FILTER_REJECTED',
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      marketCapSol: event.marketCapSol,
      filterReason: creatorLocal.reason,
      timestamp: Date.now(),
    });
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
    // La ventana de observación necesita el stream de trades del mint
    const observing = config.ENTRY_OBSERVATION_SECONDS > 0;
    if (observing) subscribeToMintTrades(event.mint);

    // En paralelo: filtros de metadatos, historial del creador y observación.
    // La observación (varios segundos) absorbe la latencia de los otros dos.
    const [filterResult, creatorHistory, obsResult] = await Promise.all([
      applyFilters(event),
      checkCreatorHistory(event.traderPublicKey),
      observing
        ? observeToken(event)
        : Promise.resolve(null as ObservationResult | null),
    ]);

    const rejectionReason = !filterResult.passed
      ? filterResult.reason
      : !creatorHistory.passed
        ? creatorHistory.reason
        : obsResult && !obsResult.passed
          ? obsResult.reason
          : null;

    if (rejectionReason) {
      logger.info(
        { mint: event.mint, symbol: event.symbol, reason: rejectionReason },
        '🚫 Entrada RECHAZADA',
      );
      recordRejection({
        mint: event.mint,
        symbol: event.symbol,
        reason: rejectionReason,
        mcapSol: obsResult?.finalMcap ?? event.marketCapSol,
      });
      await sendWebhook({
        event: 'FILTER_REJECTED',
        mint: event.mint,
        name: event.name,
        symbol: event.symbol,
        marketCapSol: obsResult?.finalMcap ?? event.marketCapSol,
        filterReason: rejectionReason,
        timestamp: Date.now(),
      });
      return;
    }

    // Pudo pausarse (o dispararse el circuit breaker) durante la ventana
    if (state.isPaused) {
      logger.info({ mint: event.mint }, 'Bot pausado durante la observación — compra cancelada');
      return;
    }

    if (obsResult) {
      logger.info(
        {
          mint: event.mint,
          uniqueBuyers: obsResult.uniqueBuyers,
          buys: obsResult.buyCount,
          sells: obsResult.sellCount,
          mcap: obsResult.finalMcap.toFixed(2),
        },
        '✅ Observación superada — token con tracción',
      );
    }

    // Concentración de holders — post-observación, cuando ya hay holders reales
    const holderCheck = await checkHolderConcentration(event.mint);
    if (!holderCheck.passed) {
      logger.info(
        { mint: event.mint, reason: holderCheck.reason },
        '🚫 Filtro RECHAZADO [holderConcentration]',
      );
      recordRejection({
        mint: event.mint,
        symbol: event.symbol,
        reason: holderCheck.reason ?? 'holder concentrado',
        mcapSol: obsResult?.finalMcap ?? event.marketCapSol,
      });
      await sendWebhook({
        event: 'FILTER_REJECTED',
        mint: event.mint,
        name: event.name,
        symbol: event.symbol,
        marketCapSol: obsResult?.finalMcap ?? event.marketCapSol,
        filterReason: holderCheck.reason,
        timestamp: Date.now(),
      });
      return;
    }

    // Verificar balance descontando el SOL ya comprometido en otras compras
    const solBalance = await getSolBalance();
    const availableSol = solBalance - reservedSol;

    // Dynamic position sizing: usa % del SOL libre si DYNAMIC_BUY_PERCENT > 0
    const buyAmount =
      config.DYNAMIC_BUY_PERCENT > 0
        ? Math.max(availableSol * (config.DYNAMIC_BUY_PERCENT / 100), 0.001)
        : config.BUY_AMOUNT_SOL;

    // Reserva mínima de SOL — siempre conservar MIN_SOL_RESERVE para fees
    if (availableSol < buyAmount + config.MIN_SOL_RESERVE) {
      logger.warn(
        { solBalance, reservedSol, required: buyAmount, reserve: config.MIN_SOL_RESERVE },
        '⚠️  Balance insuficiente — reserva mínima protegida',
      );
      return;
    }

    // Comprometer el monto ANTES del await de compra (sin gaps async)
    reservedSol += buyAmount;
    let buyResult: BuyResult;
    try {
      // El mcap observado alimenta la simulación del fill en DRY_RUN
      buyResult = await buyToken(
        event.mint,
        buyAmount,
        obsResult?.finalMcap ?? event.marketCapSol,
      );
    } finally {
      reservedSol -= buyAmount;
    }

    // Registrar símbolo como comprado (antes de addPosition para proteger contra errores)
    recentSymbolBuys.set(symbolKey, Date.now());

    // -----------------------------------------------------------------
    // ENTRADA REAL: calculada del fill (SOL pagado / tokens recibidos),
    // no del mcap del evento `create` (que queda viejo tras la latencia
    // de filtros + observación + confirmación). Todo TP/SL se ancla aquí.
    // -----------------------------------------------------------------
    const entryMcap =
      buyResult.tokenBalance >= 1
        ? (buyAmount / buyResult.tokenBalance) * config.PUMP_TOTAL_SUPPLY
        : (obsResult?.finalMcap ?? event.marketCapSol);

    const tradeRecord = {
      timestamp: Date.now(),
      action: 'BUY' as const,
      tokenAmount: buyResult.tokenBalance,
      solAmount: buyAmount,
      marketCapSol: entryMcap,
      signature: buyResult.signature,
      reason: 'Filtros y observación superados — compra inicial',
    };

    const position: Position = {
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      entryMarketCapSol: entryMcap,
      currentMarketCapSol: entryMcap,
      tokenBalance: buyResult.tokenBalance,
      initialTokenBalance: buyResult.tokenBalance,
      solSpent: buyAmount,
      solReceived: 0,
      entryTimestamp: Date.now(),
      tp1Hit: false,
      tp2Hit: false,
      status: 'ACTIVE',
      bondingCurveKey: event.bondingCurveKey,
      creator: event.traderPublicKey,
      trades: [tradeRecord],
      // Condiciones de entrada — se archivan con el PnL para el análisis
      // posterior de qué configuraciones ganan dinero de verdad
      entryContext: {
        observationSec: config.ENTRY_OBSERVATION_SECONDS,
        uniqueBuyers: obsResult?.uniqueBuyers,
        buyCount: obsResult?.buyCount,
        sellCount: obsResult?.sellCount,
        devBuyPercent: (event.tokenAmount / config.PUMP_TOTAL_SUPPLY) * 100,
        devSolAmount: event.solAmount,
        createMcapSol: event.marketCapSol,
        entryMcapSol: entryMcap,
        hourUtc: new Date().getUTCHours(),
      },
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
      marketCapSol: entryMcap,
      solAmount: buyAmount,
      tokenAmount: buyResult.tokenBalance,
      signature: buyResult.signature,
      timestamp: Date.now(),
      position: {
        entryMarketCapSol: entryMcap,
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
    // Si no quedó posición (rechazo o error), limpiar la suscripción temporal
    if (!hasActivePosition(event.mint)) {
      unsubscribeMintTrades(event.mint);
    }
  }
}

async function handleTradeEvent(event: TradeEvent): Promise<void> {
  await processTradeEvent(event);
}

// -----------------------------------------------------------
// Manejo de mensajes WebSocket entrantes
// -----------------------------------------------------------

function onWsMessage(data: WebSocket.RawData): void {
  markWsMessage();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data.toString()) as Record<string, unknown>;
  } catch {
    logger.warn('Mensaje WS no parseable ignorado');
    return;
  }

  const txType = parsed['txType'];

  if (txType === 'create') {
    const event = parsed as unknown as NewTokenEvent;
    // Eventos malformados (sin mint o sin creador) — ignorar
    if (typeof event.mint !== 'string' || typeof event.traderPublicKey !== 'string') return;
    // Dataset para backtesting: grabar TODOS los create
    recordFirehose('create', parsed);
    // Inteligencia de creadores: registrar TODOS los create, se compre o no
    registerTokenCreation(event.traderPublicKey);
    // Usar void + IIFE para manejar la promesa sin bloquear el event loop
    void (async () => {
      try {
        await handleNewToken(event);
      } catch (err) {
        logger.error({ err }, 'Error no capturado en handleNewToken');
      }
    })();
  } else if (txType === 'buy' || txType === 'sell') {
    const event = parsed as unknown as TradeEvent;
    // Los mints bajo observación consumen el evento aquí
    const underObservation = handleObservationTrade(event);
    // Grabar los trades de mints observados o con posición (backtesting)
    if (underObservation || hasActivePosition(event.mint)) {
      recordFirehose('trade', parsed);
    }
    if (underObservation) return;
    void (async () => {
      try {
        await handleTradeEvent(event);
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
      markWsMessage();
      logger.info('🟢 WebSocket conectado a PumpPortal');

      // Suscribirse a nuevos tokens
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

      // Re-suscribirse a los mints de posiciones activas (en un solo mensaje)
      if (state.subscribedMints.size > 0) {
        ws.send(
          JSON.stringify({
            method: 'subscribeTokenTrade',
            keys: Array.from(state.subscribedMints),
          }),
        );
      }

      logger.info(
        { resubscribedMints: state.subscribedMints.size },
        '📡 Suscripciones enviadas',
      );
    });

    ws.on('message', onWsMessage);
    ws.on('pong', markWsMessage);

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
// Watchdog del WebSocket — detecta conexiones "zombies"
// -----------------------------------------------------------
// PumpPortal puede dejar de emitir sin cerrar el socket. Con
// posiciones abiertas eso significa quedarse ciego sin SL.
// Si no llega NINGÚN mensaje en WS_MAX_SILENCE_MS → reconectar.

function startWsWatchdog(): void {
  setInterval(() => {
    const ws = state.wsInstance;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const silenceMs = Date.now() - state.lastWsMessageAt;

    if (silenceMs >= config.WS_MAX_SILENCE_MS) {
      logger.warn(
        { silenceMs, limit: config.WS_MAX_SILENCE_MS },
        '🐶 Watchdog: WebSocket silencioso — forzando reconexión',
      );
      ws.terminate(); // dispara 'close' → reconexión automática
    } else if (silenceMs >= config.WS_MAX_SILENCE_MS / 2) {
      ws.ping();
    }
  }, 5_000);

  logger.info(
    { maxSilenceMs: config.WS_MAX_SILENCE_MS },
    '🐶 Watchdog de WebSocket iniciado',
  );
}

// -----------------------------------------------------------
// Mantenimiento periódico — purga de mapas en memoria
// -----------------------------------------------------------

function startMaintenance(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [symbol, ts] of recentSymbolBuys) {
      if (now - ts > SYMBOL_COOLDOWN_MS) recentSymbolBuys.delete(symbol);
    }
    pruneCreatorRegistry();
  }, 60_000);

  // Barrido de ganancias a wallet fría — cada 10 min (desactivado por defecto;
  // requiere PROFIT_SWEEP_ADDRESS y PROFIT_SWEEP_THRESHOLD_SOL en .env)
  setInterval(() => {
    void (async () => {
      const swept = await sweepProfits();
      if (swept) {
        await sendWebhook({
          event: 'PROFIT_SWEPT',
          mint: 'SYSTEM',
          solAmount: parseFloat(swept.amountSol.toFixed(6)),
          signature: swept.signature,
          timestamp: Date.now(),
        });
      }
    })();
  }, 10 * 60_000);
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
    // Con dinero en juego, un estado corrupto es peor que un reinicio:
    // salir y dejar que PM2 levante el proceso limpio (las posiciones
    // se recuperan de positions.json).
    logger.fatal({ err }, '🚨 uncaughtException — reiniciando proceso');
    process.exit(1);
  });
}

// -----------------------------------------------------------
// main
// -----------------------------------------------------------

async function main(): Promise<void> {
  logger.info(
    config.DRY_RUN
      ? '🚀 Iniciando PumpFun Sniper Bot — 🧪 MODO DRY RUN (paper trading, sin dinero real)'
      : '🚀 Iniciando PumpFun Sniper Bot',
  );

  // Montar manejadores de señales
  setupGracefulShutdown();

  // Cargar métricas diarias y circuit breaker
  initRiskManager();

  // Grabador de firehose para backtesting offline
  startRecorder();

  // Iniciar API interna (Fastify)
  await startServer();

  // Cargar posiciones persistidas y re-suscribir mints activos
  initPositionManager();

  // Iniciar monitor de posiciones (TP/SL + balance + tiempo)
  startPositionMonitor();

  // Watchdog y mantenimiento
  startWsWatchdog();
  startMaintenance();

  // Conectar WebSocket a PumpPortal
  connectWebSocket();

  logger.info(
    {
      mode: config.DRY_RUN ? `DRY RUN (balance virtual ${config.DRY_RUN_START_BALANCE_SOL} SOL)` : 'REAL',
      buyMode: config.DYNAMIC_BUY_PERCENT > 0 ? `${config.DYNAMIC_BUY_PERCENT}% del balance` : `${config.BUY_AMOUNT_SOL} SOL fijo`,
      entryMode:
        config.ENTRY_OBSERVATION_SECONDS > 0
          ? `observación ${config.ENTRY_OBSERVATION_SECONDS}s (mín. ${config.MIN_UNIQUE_BUYERS} compradores)`
          : 'snipe inmediato',
      maxPositions: config.MAX_CONCURRENT_POSITIONS,
      tp1: `+${config.TP1_PERCENT}% → sell ${config.TP1_SELL_PERCENT}%`,
      tp2: `+${config.TP2_PERCENT}% → sell ${config.TP2_SELL_PERCENT}%`,
      sl: `-${config.SL_PERCENT}%`,
      circuitBreaker: `-${config.MAX_DAILY_LOSS_SOL} SOL/día o ${config.MAX_CONSECUTIVE_LOSSES} pérdidas seguidas`,
      maxMcapEntry: config.MAX_ENTRY_MCAP_SOL > 0 ? `${config.MAX_ENTRY_MCAP_SOL} SOL` : 'sin límite',
      minSolReserve: `${config.MIN_SOL_RESERVE} SOL`,
    },
    '⚙️  Parámetros de trading',
  );
}

void main();
