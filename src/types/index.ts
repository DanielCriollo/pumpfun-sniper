// ============================================================
//  PUMPFUN SNIPER BOT — Tipos e Interfaces Globales
// ============================================================

// -----------------------------------------------------------
// Configuración cargada desde .env
// -----------------------------------------------------------
export interface Config {
  // Solana
  RPC_ENDPOINT: string;
  WS_PUMPFUN_ENDPOINT: string;
  PUMPFUN_API_URL: string;
  PRIVATE_KEY: string;

  // Trading
  BUY_AMOUNT_SOL: number;
  SLIPPAGE_PERCENT: number;
  PRIORITY_FEE_SOL: number;

  // Filtros anti-rug
  MAX_DEV_BUY_PERCENT: number;
  MAX_DEV_SOL_AMOUNT: number;
  MIN_DEV_SOL_AMOUNT: number;
  REQUIRE_SOCIAL_LINKS: boolean;
  METADATA_TIMEOUT_MS: number;
  PUMP_TOTAL_SUPPLY: number; // 1_000_000_000 para pump.fun

  // Take Profit (basado en % de ganancia sobre entrada)
  TP1_PERCENT: number;       // 50  → vender al +50% de ganancia (1.5x mcap)
  TP1_SELL_PERCENT: number;  // 50  → vender el 50% del balance inicial
  TP2_PERCENT: number;       // 100 → vender al +100% de ganancia (2x mcap)
  TP2_SELL_PERCENT: number;  // 25  → vender el 25% adicional del balance inicial

  // Stop Loss fijo (inicial)
  SL_PERCENT: number;        // 15  → stop loss en -15% desde entrada

  // Trailing Stop Loss
  TRAILING_SL_BREAKEVEN_PERCENT: number;  // 30 → al +30%, SL sube a breakeven (entrada)
  TRAILING_SL_ACTIVATE_PERCENT: number;   // 60 → al +60%, activa trailing
  TRAILING_SL_DISTANCE_PERCENT: number;   // 15 → trailing SL = HWM - 15%

  // Salida por tiempo (posiciones zombie)
  MAX_HOLD_MINUTES: number;               // 15 → cerrar posición si lleva > 15 min
  SL_TIGHTEN_AFTER_MINUTES: number;     // min sin TP antes de apretar SL
  SL_TIGHT_PERCENT: number;             // SL apretado tras N min estancado

  // Servidor de control
  API_PORT: number;
  API_SECRET_KEY: string;

  // Webhooks n8n
  N8N_WEBHOOK_URL: string;
  N8N_WEBHOOK_SECRET: string;

  // WebSocket
  WS_RECONNECT_DELAY_MS: number;
  WS_MAX_RECONNECT_ATTEMPTS: number;

  // Límites
  MAX_CONCURRENT_POSITIONS: number;
  MAX_ENTRY_MCAP_SOL: number;   // 0 = sin límite; >0 = rechazar tokens con mcap mayor
  MIN_SOL_RESERVE: number;      // SOL mínimo reservado en wallet (fees + buffer seguridad)

  // Position sizing dinámico (0 = desactivado → usa BUY_AMOUNT_SOL fijo)
  DYNAMIC_BUY_PERCENT: number;

  // Estrategia de entrada — ventana de observación
  ENTRY_OBSERVATION_SECONDS: number;  // 0 = snipe inmediato al create
  MIN_UNIQUE_BUYERS: number;          // compradores únicos mínimos en la ventana

  // Filtros de creador
  CREATOR_MAX_TOKENS_PER_DAY: number; // máx. tokens creados por el mismo dev en 24h
  CHECK_CREATOR_HISTORY: boolean;     // consulta RPC del historial del dev
  CREATOR_HISTORY_MAX_TXS: number;    // rechazar si el dev tiene >= N txs (wallet hiperactiva)

  // Circuit breaker (gestión de riesgo global)
  MAX_DAILY_LOSS_SOL: number;         // pausa el bot si la pérdida diaria supera esto (0 = off)
  MAX_CONSECUTIVE_LOSSES: number;     // pausa el bot tras N pérdidas seguidas (0 = off)

  // WebSocket watchdog
  WS_MAX_SILENCE_MS: number;          // reconectar si no llega ningún mensaje en N ms

  // Fees
  DYNAMIC_PRIORITY_FEE: boolean;      // calcular priority fee según congestión de red
  MAX_PRIORITY_FEE_SOL: number;       // techo del fee dinámico
  SKIP_PREFLIGHT: boolean;            // true = más rápido, sin simulación previa
}

// -----------------------------------------------------------
// Eventos de WebSocket — PumpPortal
// -----------------------------------------------------------

/** Emitido por subscribeNewToken cuando se crea un token */
export interface NewTokenEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;   // Wallet del creador (dev)
  txType: 'create';
  initialBuy: number;        // SOL que compró el dev en el bloque de creación
  solAmount: number;         // SOL del dev en la transacción de creación
  tokenAmount: number;       // Tokens que recibió el dev (en unidades display)
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri: string;               // URI del JSON de metadatos (IPFS / Arweave)
  pool: string;
}

/** Emitido por subscribeTokenTrade en cada operación */
export interface TradeEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: 'buy' | 'sell';
  tokenAmount: number;       // Tokens intercambiados (unidades display)
  solAmount: number;
  newTokenBalance: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  pool: string;
}

// -----------------------------------------------------------
// Posición de trading
// -----------------------------------------------------------
export interface TradeRecord {
  timestamp: number;
  action: 'BUY' | 'SELL';
  tokenAmount: number;
  solAmount: number;
  marketCapSol: number;
  signature: string;
  reason: string;
}

export interface Position {
  mint: string;
  name: string;
  symbol: string;

  // Market cap en el momento de la compra
  entryMarketCapSol: number;

  // Market cap actualizado en tiempo real
  currentMarketCapSol: number;

  // Token balance en unidades display (dividido por 10^6)
  tokenBalance: number;
  initialTokenBalance: number;

  solSpent: number;
  entryTimestamp: number;

  // Flags de TP ya ejecutados
  tp1Hit: boolean;
  tp2Hit: boolean;

  status: 'ACTIVE' | 'CLOSED';
  bondingCurveKey: string;
  trades: TradeRecord[];

  /** Wallet del creador del token — para detectar dev-sells */
  creator?: string;
  /** SOL real recibido acumulado en todas las ventas (neto de fees) */
  solReceived?: number;
  /** PnL realizado en SOL al cerrar (solReceived - solSpent) */
  realizedPnlSol?: number;

  // ------- Trailing Stop Loss (inicializado por addPosition) -------
  /** Máximo market cap visto desde la apertura */
  highWaterMarkMcap?: number;
  /** SL ha subido a breakeven (= entryMarketCapSol) */
  breakevenActive?: boolean;
  /** Trailing SL activo (SL = HWM - TRAILING_SL_DISTANCE_PERCENT%) */
  trailingSLActive?: boolean;
  /** Umbral de SL efectivo en SOL (se actualiza dinámicamente) */
  effectiveSLThreshold?: number;
}

// -----------------------------------------------------------
// Webhooks hacia n8n
// -----------------------------------------------------------
export type WebhookEvent =
  | 'TOKEN_BOUGHT'
  | 'TP1_TRIGGERED'
  | 'TP2_TRIGGERED'
  | 'SL_TRIGGERED'
  | 'PANIC_SELL'
  | 'TRADE_ERROR'
  | 'FILTER_REJECTED'
  | 'POSITION_CLOSED_TIME_EXPIRED'
  | 'POSITION_CLOSED_EXTERNAL'
  | 'DEV_SELL_EXIT'
  | 'CIRCUIT_BREAKER_TRIGGERED';

export interface WebhookPayload {
  event: WebhookEvent;
  mint: string;
  name?: string;
  symbol?: string;
  marketCapSol?: number;
  solAmount?: number;
  tokenAmount?: number;
  signature?: string;
  error?: string;
  filterReason?: string;
  pnlPercent?: number;       // PnL estimado en % al cerrar la posición
  realizedPnlSol?: number;   // PnL REAL en SOL (SOL recibido - SOL gastado)
  timestamp: number;
  position?: Partial<Position>;
}

// -----------------------------------------------------------
// Filtros anti-rug
// -----------------------------------------------------------
export interface FilterResult {
  passed: boolean;
  reason?: string;
  score: number; // 0-100: puntuación de seguridad
}

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  [key: string]: unknown;
}

// -----------------------------------------------------------
// Respuestas internas del servidor
// -----------------------------------------------------------
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
