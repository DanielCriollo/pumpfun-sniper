// -----------------------------------------------------------
// Setup de entorno para tests — DEBE importarse ANTES que
// cualquier módulo del bot (config.ts lee process.env al cargar).
// -----------------------------------------------------------
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

process.env['NODE_ENV'] = 'production'; // pino sin transport worker (evita colgar node --test)
process.env['LOG_LEVEL'] = 'silent';
process.env['RPC_ENDPOINT'] = 'http://127.0.0.1:8899';
process.env['PRIVATE_KEY'] = bs58.encode(Keypair.generate().secretKey);
process.env['API_SECRET_KEY'] = 'test-secret';
process.env['N8N_WEBHOOK_URL'] = 'http://127.0.0.1:1/webhook';
process.env['N8N_WEBHOOK_SECRET'] = 'test-secret';
process.env['DRY_RUN'] = 'true';

// Parámetros de trading fijos para que los tests no dependan
// de defaults que puedan cambiar en config.ts
process.env['TP1_PERCENT'] = '50';
process.env['TP1_SELL_PERCENT'] = '50';
process.env['TP2_PERCENT'] = '100';
process.env['TP2_SELL_PERCENT'] = '25';
process.env['SL_PERCENT'] = '15';
process.env['TRAILING_SL_BREAKEVEN_PERCENT'] = '30';
process.env['TRAILING_SL_ACTIVATE_PERCENT'] = '60';
process.env['TRAILING_SL_DISTANCE_PERCENT'] = '15';
process.env['SL_TIGHTEN_AFTER_MINUTES'] = '3';
process.env['SL_TIGHT_PERCENT'] = '7';
