import { PublicKey } from '@solana/web3.js';
import {
  wallet,
  getTokenDisplayBalance,
  signAndSendTransaction,
  getTokenDeltaFromTx,
  getWalletSolDeltaFromTx,
  getPriorityFeeSol,
} from './solana';
import { config } from '../config';
import { logger } from '../logger';

// -----------------------------------------------------------
// Motor de ejecución de trades en Pump.fun
// Se apoya en la API de PumpPortal para construir las txs.
// -----------------------------------------------------------

interface PumpTradeParams {
  action: 'buy' | 'sell';
  mint: string;
  /** SOL si es compra (denominatedInSol=true), tokens si es venta */
  amount: number;
  denominatedInSol: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Llama a la API de PumpPortal para obtener la transacción serializada,
 * la firma con nuestro wallet y la envía a la red.
 * Lanza error ante cualquier fallo de la API o de la red.
 */
async function executePumpTrade(params: PumpTradeParams): Promise<string> {
  const body = {
    publicKey: wallet.publicKey.toBase58(),
    action: params.action,
    mint: params.mint,
    denominatedInSol: params.denominatedInSol ? 'true' : 'false',
    amount: params.amount,
    slippage: config.SLIPPAGE_PERCENT,
    priorityFee: await getPriorityFeeSol(),
    // 'auto' resuelve el pool correcto — crítico para vender tokens
    // que ya migraron de la bonding curve a PumpSwap/Raydium
    pool: 'auto',
  };

  logger.debug({ body }, 'Llamando PumpPortal API');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000); // 15 s timeout

  let response: Response;
  try {
    response = await fetch(config.PUMPFUN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>');
    throw new Error(
      `PumpPortal API error ${response.status}: ${text}`,
    );
  }

  // La API devuelve los bytes de la transacción serializada directamente
  const txBytes = new Uint8Array(await response.arrayBuffer());
  if (txBytes.length === 0) {
    throw new Error('PumpPortal devolvió una respuesta vacía');
  }

  const signature = await signAndSendTransaction(txBytes);
  return signature;
}

// -----------------------------------------------------------
// Retry de balance tras compra — la RPC tarda en propagar el ATA
// -----------------------------------------------------------

/**
 * Reintenta leer el balance del token hasta que sea > 0.
 * La RPC puede tardar varios segundos en ver el ATA recién creado.
 * Hasta maxAttempts intentos con delayMs ms de espera entre ellos.
 */
async function waitForTokenBalance(
  mint: PublicKey,
  maxAttempts = 5,
  delayMs = 1500,
): Promise<number> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const bal = await getTokenDisplayBalance(mint);
    if (bal > 0) {
      logger.debug(
        { mint: mint.toBase58(), attempt, bal },
        'Balance token confirmado tras propagación RPC',
      );
      return bal;
    }
    if (attempt < maxAttempts) {
      logger.debug(
        { mint: mint.toBase58(), attempt, maxAttempts },
        `Balance aún 0 — esperando propagación RPC (intento ${attempt}/${maxAttempts})`,
      );
      await sleep(delayMs);
    }
  }
  logger.warn(
    { mint: mint.toBase58(), maxAttempts },
    '⚠️  Balance sigue en 0 tras todos los reintentos — posición registrada con balance=0',
  );
  return 0;
}

// -----------------------------------------------------------
// Compra
// -----------------------------------------------------------

export interface BuyResult {
  signature: string;
  tokenBalance: number; // balance real post-compra (unidades display)
  mint: string;
}

/**
 * Compra `solAmount` SOL de `mint` en Pump.fun.
 * Devuelve la firma y el balance real del token tras confirmar.
 */
export async function buyToken(
  mint: string,
  solAmount: number = config.BUY_AMOUNT_SOL,
): Promise<BuyResult> {
  logger.info(
    { mint, solAmount },
    '⚡ Ejecutando COMPRA',
  );

  const signature = await executePumpTrade({
    action: 'buy',
    mint,
    amount: solAmount,
    denominatedInSol: true,
  });

  // Fuente primaria: tokens exactos del fill leídos de la tx confirmada.
  // Fallback: polling del ATA (la RPC tarda en propagarlo).
  let tokenBalance = (await getTokenDeltaFromTx(signature, mint)) ?? 0;
  if (tokenBalance < 1) {
    tokenBalance = await waitForTokenBalance(new PublicKey(mint));
  }

  logger.info(
    { mint, signature, tokenBalance, solAmount },
    '✅ COMPRA confirmada',
  );

  return { signature, tokenBalance, mint };
}

// -----------------------------------------------------------
// Venta
// -----------------------------------------------------------

export interface SellResult {
  signature: string;
  mint: string;
  tokensSold: number;
  /** SOL neto recibido en la venta (leído de la tx confirmada; 0 si no se pudo leer) */
  solReceived: number;
}

/**
 * Vende exactamente `tokenAmount` tokens (unidades display) de `mint`.
 * Usa denominatedInSol=false → el monto se interpreta como tokens.
 */
export async function sellToken(
  mint: string,
  tokenAmount: number,
): Promise<SellResult> {
  logger.info(
    { mint, tokenAmount },
    '💸 Ejecutando VENTA',
  );

  const roundedAmount = Math.floor(tokenAmount); // sin decimales parciales

  const signature = await executePumpTrade({
    action: 'sell',
    mint,
    amount: roundedAmount,
    denominatedInSol: false,
  });

  // SOL REAL recibido (neto de fees) — imprescindible para medir PnL de verdad
  const solReceived = (await getWalletSolDeltaFromTx(signature)) ?? 0;
  if (solReceived <= 0) {
    logger.warn(
      { mint, signature },
      '⚠️  No se pudo leer el SOL recibido de la tx — PnL de esta venta quedará en 0',
    );
  }

  logger.info(
    { mint, signature, tokenAmount: roundedAmount, solReceived: solReceived.toFixed(6) },
    '✅ VENTA confirmada',
  );

  return { signature, mint, tokensSold: roundedAmount, solReceived: Math.max(0, solReceived) };
}
