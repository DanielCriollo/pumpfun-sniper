import { PublicKey } from '@solana/web3.js';
import { wallet, getTokenDisplayBalance, signAndSendTransaction } from './solana';
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
    priorityFee: config.PRIORITY_FEE_SOL,
    pool: 'pump',
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

  // Obtener balance real desde la cadena para evitar estimaciones
  const tokenBalance = await getTokenDisplayBalance(new PublicKey(mint));

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

  logger.info(
    { mint, signature, tokenAmount: roundedAmount },
    '✅ VENTA confirmada',
  );

  return { signature, mint, tokensSold: roundedAmount };
}
