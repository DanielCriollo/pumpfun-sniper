import 'dotenv/config';
import { Config } from './types';

// -----------------------------------------------------------
// Helpers para leer variables de entorno con validación
// -----------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[Config] Variable de entorno requerida no definida: ${key}`);
  }
  return value.trim();
}

function envNumber(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const num = parseFloat(raw);
  if (isNaN(num)) {
    throw new Error(`[Config] ${key} debe ser un número, valor recibido: "${raw}"`);
  }
  return num;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw.toLowerCase() === 'true';
}

function envString(key: string, defaultValue: string): string {
  const raw = process.env[key];
  return raw === undefined ? defaultValue : raw.trim();
}

// -----------------------------------------------------------
// Objeto de configuración global (inmutable en runtime)
// -----------------------------------------------------------
export const config: Config = {
  // Solana
  RPC_ENDPOINT: requireEnv('RPC_ENDPOINT'),
  WS_PUMPFUN_ENDPOINT:
    process.env['WS_PUMPFUN_ENDPOINT'] ?? 'wss://pumpportal.fun/api/data',
  PUMPFUN_API_URL:
    process.env['PUMPFUN_API_URL'] ?? 'https://pumpportal.fun/api/trade-local',
  PRIVATE_KEY: requireEnv('PRIVATE_KEY'),
  PUMPPORTAL_API_KEY: envString('PUMPPORTAL_API_KEY', ''),

  // Trading
  BUY_AMOUNT_SOL: envNumber('BUY_AMOUNT_SOL', 0.05),
  SLIPPAGE_PERCENT: envNumber('SLIPPAGE_PERCENT', 10),
  PRIORITY_FEE_SOL: envNumber('PRIORITY_FEE_SOL', 0.001),

  // Filtros anti-rug
  MAX_DEV_BUY_PERCENT: envNumber('MAX_DEV_BUY_PERCENT', 6),
  MAX_DEV_SOL_AMOUNT: envNumber('MAX_DEV_SOL_AMOUNT', 10),
  MIN_DEV_SOL_AMOUNT: envNumber('MIN_DEV_SOL_AMOUNT', 0.000001),
  REQUIRE_SOCIAL_LINKS: envBool('REQUIRE_SOCIAL_LINKS', true),
  METADATA_TIMEOUT_MS: envNumber('METADATA_TIMEOUT_MS', 3000),
  PUMP_TOTAL_SUPPLY: envNumber('PUMP_TOTAL_SUPPLY', 1_000_000_000),

  // Take Profit (% de ganancia desde la entrada)
  TP1_PERCENT: envNumber('TP1_PERCENT', 50),       // +50% de ganancia = 1.5x
  TP1_SELL_PERCENT: envNumber('TP1_SELL_PERCENT', 50),
  TP2_PERCENT: envNumber('TP2_PERCENT', 100),      // +100% de ganancia = 2x
  TP2_SELL_PERCENT: envNumber('TP2_SELL_PERCENT', 25),

  // Stop Loss fijo inicial
  SL_PERCENT: envNumber('SL_PERCENT', 15),         // -15% desde entrada

  // Trailing Stop Loss
  TRAILING_SL_BREAKEVEN_PERCENT: envNumber('TRAILING_SL_BREAKEVEN_PERCENT', 30),
  TRAILING_SL_ACTIVATE_PERCENT: envNumber('TRAILING_SL_ACTIVATE_PERCENT', 60),
  TRAILING_SL_DISTANCE_PERCENT: envNumber('TRAILING_SL_DISTANCE_PERCENT', 15),

  // Salida por tiempo
  MAX_HOLD_MINUTES: envNumber('MAX_HOLD_MINUTES', 15),
  SL_TIGHTEN_AFTER_MINUTES: envNumber('SL_TIGHTEN_AFTER_MINUTES', 3),  // apretar SL tras 3 min sin TP
  SL_TIGHT_PERCENT: envNumber('SL_TIGHT_PERCENT', 7),                   // SL apretado = -7%

  // Servidor interno
  API_PORT: envNumber('API_PORT', 3000),
  API_SECRET_KEY: requireEnv('API_SECRET_KEY'),

  // n8n
  N8N_WEBHOOK_URL: requireEnv('N8N_WEBHOOK_URL'),
  N8N_WEBHOOK_SECRET: requireEnv('N8N_WEBHOOK_SECRET'),

  // WebSocket
  WS_RECONNECT_DELAY_MS: envNumber('WS_RECONNECT_DELAY_MS', 5000),
  WS_MAX_RECONNECT_ATTEMPTS: envNumber('WS_MAX_RECONNECT_ATTEMPTS', 20),

  // Límites
  MAX_CONCURRENT_POSITIONS: envNumber('MAX_CONCURRENT_POSITIONS', 5),
  MAX_ENTRY_MCAP_SOL: envNumber('MAX_ENTRY_MCAP_SOL', 60),      // rechazar si mcap inicial > X SOL (0 = desactivado)
  MIN_SOL_RESERVE: envNumber('MIN_SOL_RESERVE', 0.02),            // SOL mínimo que el bot siempre conserva

  // Position sizing dinámico
  DYNAMIC_BUY_PERCENT: envNumber('DYNAMIC_BUY_PERCENT', 0),

  // Estrategia de entrada — ventana de observación (0 = snipe inmediato)
  ENTRY_OBSERVATION_SECONDS: envNumber('ENTRY_OBSERVATION_SECONDS', 8),
  MIN_UNIQUE_BUYERS: envNumber('MIN_UNIQUE_BUYERS', 4),
  MIN_VSOL_IN_CURVE: envNumber('MIN_VSOL_IN_CURVE', 33),

  // Filtros de creador
  CREATOR_MAX_TOKENS_PER_DAY: envNumber('CREATOR_MAX_TOKENS_PER_DAY', 1),
  CHECK_CREATOR_HISTORY: envBool('CHECK_CREATOR_HISTORY', true),
  CREATOR_HISTORY_MAX_TXS: envNumber('CREATOR_HISTORY_MAX_TXS', 100),

  // Circuit breaker
  MAX_DAILY_LOSS_SOL: envNumber('MAX_DAILY_LOSS_SOL', 0.3),
  MAX_CONSECUTIVE_LOSSES: envNumber('MAX_CONSECUTIVE_LOSSES', 5),

  // WebSocket watchdog
  WS_MAX_SILENCE_MS: envNumber('WS_MAX_SILENCE_MS', 45_000),

  // Fees
  DYNAMIC_PRIORITY_FEE: envBool('DYNAMIC_PRIORITY_FEE', false),
  MAX_PRIORITY_FEE_SOL: envNumber('MAX_PRIORITY_FEE_SOL', 0.005),
  SKIP_PREFLIGHT: envBool('SKIP_PREFLIGHT', false),

  // Paper trading
  DRY_RUN: envBool('DRY_RUN', false),
  DRY_RUN_START_BALANCE_SOL: envNumber('DRY_RUN_START_BALANCE_SOL', 1),

  // Salida por muerte de volumen
  VOLUME_EXIT_WINDOW_SEC: envNumber('VOLUME_EXIT_WINDOW_SEC', 45),
  VOLUME_EXIT_MIN_TRADES: envNumber('VOLUME_EXIT_MIN_TRADES', 3),

  // RPC de respaldo
  RPC_FALLBACK_ENDPOINT: envString('RPC_FALLBACK_ENDPOINT', ''),

  // Concentración de holders
  MAX_HOLDER_PERCENT: envNumber('MAX_HOLDER_PERCENT', 15),

  // Barrido de ganancias
  PROFIT_SWEEP_ADDRESS: envString('PROFIT_SWEEP_ADDRESS', ''),
  PROFIT_SWEEP_THRESHOLD_SOL: envNumber('PROFIT_SWEEP_THRESHOLD_SOL', 0),
  PROFIT_SWEEP_KEEP_SOL: envNumber('PROFIT_SWEEP_KEEP_SOL', 0.5),

  // Grabación del firehose
  RECORD_FIREHOSE: envBool('RECORD_FIREHOSE', true),
};

// -----------------------------------------------------------
// Validaciones de cordura post-carga
// -----------------------------------------------------------
if (config.TP1_SELL_PERCENT + config.TP2_SELL_PERCENT > 100) {
  throw new Error('[Config] TP1_SELL_PERCENT + TP2_SELL_PERCENT no puede superar 100');
}
if (config.TP1_PERCENT >= config.TP2_PERCENT) {
  throw new Error('[Config] TP1_PERCENT debe ser menor que TP2_PERCENT');
}
if (config.TRAILING_SL_BREAKEVEN_PERCENT >= config.TRAILING_SL_ACTIVATE_PERCENT) {
  throw new Error('[Config] TRAILING_SL_BREAKEVEN_PERCENT debe ser menor que TRAILING_SL_ACTIVATE_PERCENT');
}
if (config.DYNAMIC_PRIORITY_FEE && config.MAX_PRIORITY_FEE_SOL < config.PRIORITY_FEE_SOL) {
  throw new Error('[Config] MAX_PRIORITY_FEE_SOL debe ser >= PRIORITY_FEE_SOL');
}
if (config.ENTRY_OBSERVATION_SECONDS < 0 || config.ENTRY_OBSERVATION_SECONDS > 60) {
  throw new Error('[Config] ENTRY_OBSERVATION_SECONDS debe estar entre 0 y 60');
}
if (
  config.PROFIT_SWEEP_THRESHOLD_SOL > 0 &&
  config.PROFIT_SWEEP_KEEP_SOL >= config.PROFIT_SWEEP_THRESHOLD_SOL
) {
  throw new Error('[Config] PROFIT_SWEEP_KEEP_SOL debe ser menor que PROFIT_SWEEP_THRESHOLD_SOL');
}
