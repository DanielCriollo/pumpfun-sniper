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

  // TP/SL
  TP1_MULTIPLIER: envNumber('TP1_MULTIPLIER', 2.0),
  TP1_SELL_PERCENT: envNumber('TP1_SELL_PERCENT', 50),
  TP2_MULTIPLIER: envNumber('TP2_MULTIPLIER', 3.0),
  TP2_SELL_PERCENT: envNumber('TP2_SELL_PERCENT', 25),
  SL_PERCENT: envNumber('SL_PERCENT', 15),

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
};

// Validaciones de cordura post-carga
if (config.TP1_SELL_PERCENT + config.TP2_SELL_PERCENT > 100) {
  throw new Error('[Config] TP1_SELL_PERCENT + TP2_SELL_PERCENT no puede superar 100');
}
if (config.TP1_MULTIPLIER >= config.TP2_MULTIPLIER) {
  throw new Error('[Config] TP1_MULTIPLIER debe ser menor que TP2_MULTIPLIER');
}
