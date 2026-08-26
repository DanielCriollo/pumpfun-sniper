import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
  SendTransactionError,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAccount,
  getAssociatedTokenAddress,
  TokenAccountNotFoundError,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../config';
import { logger } from '../logger';

// -----------------------------------------------------------
// Conexión y wallet — singletons
// -----------------------------------------------------------

export const connection = new Connection(config.RPC_ENDPOINT, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60_000, // ms
});

/** RPC de respaldo — usado cuando el principal falla en operaciones críticas */
export const fallbackConnection: Connection | null =
  config.RPC_FALLBACK_ENDPOINT !== ''
    ? new Connection(config.RPC_FALLBACK_ENDPOINT, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60_000,
      })
    : null;

export const wallet = Keypair.fromSecretKey(bs58.decode(config.PRIVATE_KEY));

logger.info(
  { pubkey: wallet.publicKey.toBase58() },
  'Wallet inicializada',
);

// -----------------------------------------------------------
// Constante de tokens pump.fun
// -----------------------------------------------------------
export const PUMP_TOKEN_DECIMALS = 6;

// -----------------------------------------------------------
// Consultas de balance
// -----------------------------------------------------------

// -----------------------------------------------------------
// Balance virtual — modo DRY_RUN (paper trading)
// -----------------------------------------------------------

let virtualSolBalance = config.DRY_RUN_START_BALANCE_SOL;

/** Ajusta el balance virtual (solo tiene efecto en DRY_RUN) */
export function adjustVirtualSol(delta: number): void {
  virtualSolBalance += delta;
}

export function getVirtualSolBalance(): number {
  return virtualSolBalance;
}

/** Devuelve el balance de SOL del wallet en SOL (no lamports).
 *  En DRY_RUN devuelve el balance virtual simulado. */
export async function getSolBalance(): Promise<number> {
  if (config.DRY_RUN) return virtualSolBalance;
  const lamports = await connection.getBalance(wallet.publicKey, 'confirmed');
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Devuelve el balance del token en unidades display (dividido por 10^decimals).
 * Devuelve 0 si la cuenta no existe (aún no se ha creado la ATA).
 */
export async function getTokenDisplayBalance(mint: PublicKey): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const account = await getAccount(connection, ata, 'confirmed');
    const raw = account.amount; // bigint
    return Number(raw) / 10 ** PUMP_TOKEN_DECIMALS;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) {
      return 0;
    }
    throw err;
  }
}

// -----------------------------------------------------------
// Envío de transacciones con reintentos
// -----------------------------------------------------------

const MAX_SEND_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

/** Espera N ms */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Espera la confirmación de una firma haciendo polling de
 * getSignatureStatuses. Evita el problema de confirmar con un
 * blockhash distinto al de la transacción enviada.
 */
export async function confirmSignature(
  signature: string,
  timeoutMs = 45_000,
): Promise<void> {
  const start = Date.now();
  let useFallback = false;
  while (Date.now() - start < timeoutMs) {
    const conn = useFallback && fallbackConnection ? fallbackConnection : connection;
    let status;
    try {
      status = (await conn.getSignatureStatuses([signature])).value[0];
    } catch (err) {
      // Error de red en la RPC → alternar al respaldo si existe
      if (fallbackConnection) useFallback = !useFallback;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ signature, err: msg }, 'Fallo consultando status — alternando RPC');
      await sleep(500);
      continue;
    }
    if (status) {
      if (status.err) {
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return;
      }
    }
    await sleep(500);
  }
  throw new Error(`Timeout esperando confirmación de tx ${signature}`);
}

/**
 * Firma (si es necesario) y envía una transacción deserializada.
 * Reintenta hasta MAX_SEND_RETRIES veces ante errores transitorios.
 * Lanza error si supera el límite de intentos.
 */
export async function signAndSendTransaction(
  txBytes: Uint8Array,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    // A partir del segundo intento, si hay RPC de respaldo, usarlo
    const conn =
      attempt > 1 && fallbackConnection ? fallbackConnection : connection;
    try {
      // Intentar deserializar como VersionedTransaction (v0)
      let signature: string;

      try {
        const vtx = VersionedTransaction.deserialize(txBytes);
        vtx.sign([wallet]);
        signature = await conn.sendRawTransaction(vtx.serialize(), {
          skipPreflight: config.SKIP_PREFLIGHT,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
      } catch {
        // Fallback a transacción legacy
        const tx = Transaction.from(Buffer.from(txBytes));
        tx.partialSign(wallet);
        signature = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: config.SKIP_PREFLIGHT,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
      }

      await confirmSignature(signature);

      logger.debug({ signature, attempt }, 'Transacción confirmada');
      return signature;
    } catch (err) {
      const isLast = attempt === MAX_SEND_RETRIES;
      const errMsg = err instanceof Error ? err.message : String(err);

      if (err instanceof SendTransactionError) {
        // Errores de simulación → no reintenta
        logger.error({ err: errMsg }, 'SendTransactionError — no reintentando');
        throw err;
      }

      if (isLast) {
        logger.error({ err: errMsg, attempt }, 'Máximo de reintentos alcanzado');
        throw err;
      }

      logger.warn({ err: errMsg, attempt }, `Fallo en intento ${attempt}, reintentando…`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  // TypeScript necesita este punto de retorno; nunca se alcanza
  throw new Error('Unreachable');
}

// -----------------------------------------------------------
// Lectura de transacciones confirmadas — PnL y fills reales
// -----------------------------------------------------------

/** Obtiene la transacción parseada con reintentos (la RPC tarda en indexarla) */
async function getParsedTx(
  signature: string,
  maxAttempts = 4,
  delayMs = 800,
): Promise<import('@solana/web3.js').ParsedTransactionWithMeta | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (tx) return tx;
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return null;
}

/**
 * Delta REAL de SOL de nuestra wallet en una transacción confirmada
 * (positivo en ventas, negativo en compras; incluye fees pagadas).
 * Devuelve null si la tx no se pudo leer.
 */
export async function getWalletSolDeltaFromTx(
  signature: string,
): Promise<number | null> {
  try {
    const tx = await getParsedTx(signature);
    if (!tx?.meta) return null;
    const me = wallet.publicKey.toBase58();
    const keys = tx.transaction.message.accountKeys;
    let idx = keys.findIndex((k) => k.pubkey.toBase58() === me);
    if (idx < 0) idx = 0; // fee payer somos nosotros siempre
    return (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ signature, err: msg }, 'No se pudo leer delta SOL de la tx');
    return null;
  }
}

/**
 * Tokens REALES recibidos/vendidos de `mint` por nuestra wallet en una tx
 * confirmada (unidades display). Más fiable y rápido que esperar la
 * propagación del ATA en la RPC. Devuelve null si no se pudo leer.
 */
export async function getTokenDeltaFromTx(
  signature: string,
  mint: string,
): Promise<number | null> {
  try {
    const tx = await getParsedTx(signature);
    if (!tx?.meta?.postTokenBalances) return null;
    const me = wallet.publicKey.toBase58();
    const post = tx.meta.postTokenBalances.find(
      (b) => b.mint === mint && b.owner === me,
    );
    if (!post) return null;
    const pre = tx.meta.preTokenBalances?.find(
      (b) => b.mint === mint && b.owner === me,
    );
    return (post.uiTokenAmount.uiAmount ?? 0) - (pre?.uiTokenAmount.uiAmount ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ signature, mint, err: msg }, 'No se pudo leer delta de tokens de la tx');
    return null;
  }
}

// -----------------------------------------------------------
// Priority fee dinámico según congestión de red
// -----------------------------------------------------------

const PRIORITY_FEE_CACHE_MS = 30_000;
const ASSUMED_COMPUTE_UNITS = 250_000; // CU típico de un trade en pump.fun

let priorityFeeCache = { valueSol: 0, fetchedAt: 0 };

/**
 * Priority fee en SOL para el próximo trade. Si DYNAMIC_PRIORITY_FEE está
 * activo, usa el percentil 75 de las fees recientes de la red (cacheado 30 s),
 * acotado entre PRIORITY_FEE_SOL (suelo) y MAX_PRIORITY_FEE_SOL (techo).
 */
export async function getPriorityFeeSol(): Promise<number> {
  if (!config.DYNAMIC_PRIORITY_FEE) return config.PRIORITY_FEE_SOL;

  const now = Date.now();
  if (now - priorityFeeCache.fetchedAt < PRIORITY_FEE_CACHE_MS && priorityFeeCache.valueSol > 0) {
    return priorityFeeCache.valueSol;
  }

  try {
    const fees = await connection.getRecentPrioritizationFees();
    const values = fees
      .map((f) => f.prioritizationFee)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    // microlamports por CU → SOL totales para ASSUMED_COMPUTE_UNITS
    const p75 = values.length > 0 ? values[Math.floor(values.length * 0.75)] : 0;
    const feeSol = (p75 * ASSUMED_COMPUTE_UNITS) / 1e6 / LAMPORTS_PER_SOL;
    const clamped = Math.min(
      Math.max(feeSol, config.PRIORITY_FEE_SOL),
      config.MAX_PRIORITY_FEE_SOL,
    );
    priorityFeeCache = { valueSol: clamped, fetchedAt: now };
    logger.debug({ p75MicroLamports: p75, feeSol: clamped }, 'Priority fee dinámico actualizado');
    return clamped;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Fallo leyendo fees recientes — usando fee base');
    return config.PRIORITY_FEE_SOL;
  }
}

// -----------------------------------------------------------
// Reclaim de renta de cuentas ATA vacías
// -----------------------------------------------------------

/**
 * Cierra la ATA de `mint` si está vacía, recuperando ~0.002 SOL
 * de renta bloqueada de vuelta a la wallet principal.
 * Fire-and-forget seguro: loggea errores sin lanzarlos.
 */
export async function reclaimAtaRent(mint: PublicKey): Promise<void> {
  if (config.DRY_RUN) return; // en paper trading no hay ATAs reales
  try {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);

    // Verificar que la cuenta existe y tiene balance cero
    const account = await getAccount(connection, ata, 'confirmed');
    if (account.amount > 0n) {
      logger.debug({ mint: mint.toBase58() }, 'reclaimAtaRent: ATA no vacía, omitiendo');
      return;
    }

    const ix = createCloseAccountInstruction(
      ata,              // cuenta a cerrar
      wallet.publicKey, // destino del SOL (rent)
      wallet.publicKey, // autoridad
    );

    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    const result = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    if (result.value.err) {
      throw new Error(`ATA close on-chain error: ${JSON.stringify(result.value.err)}`);
    }

    logger.info(
      { mint: mint.toBase58(), signature: sig },
      '♻️  ATA cerrada — ~0.002 SOL de rent recuperados',
    );
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return; // ATA ya no existe
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ mint: mint.toBase58(), err: msg }, 'reclaimAtaRent: no se pudo cerrar ATA');
  }
}

// -----------------------------------------------------------
// Barrido de ganancias a wallet fría
// -----------------------------------------------------------

/**
 * Si el balance supera PROFIT_SWEEP_THRESHOLD_SOL, transfiere el
 * excedente (dejando PROFIT_SWEEP_KEEP_SOL como capital de trabajo)
 * a PROFIT_SWEEP_ADDRESS. Limita lo expuesto en la wallet caliente
 * y es la única forma real de "asegurar" ganancias.
 * Devuelve el monto barrido, o null si no aplicaba.
 */
export async function sweepProfits(): Promise<{ amountSol: number; signature: string } | null> {
  if (config.DRY_RUN) return null;
  if (config.PROFIT_SWEEP_ADDRESS === '' || config.PROFIT_SWEEP_THRESHOLD_SOL <= 0) {
    return null;
  }

  try {
    const balance = await getSolBalance();
    if (balance < config.PROFIT_SWEEP_THRESHOLD_SOL) return null;

    const amountSol = balance - config.PROFIT_SWEEP_KEEP_SOL;
    if (amountSol < 0.01) return null; // no barrer migajas

    const destination = new PublicKey(config.PROFIT_SWEEP_ADDRESS);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: destination,
        lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
      }),
    );
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    const result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (result.value.err) {
      throw new Error(`Sweep on-chain error: ${JSON.stringify(result.value.err)}`);
    }

    logger.info(
      { amountSol: amountSol.toFixed(4), destination: config.PROFIT_SWEEP_ADDRESS, signature },
      '🏦 Ganancias barridas a wallet fría',
    );
    return { amountSol, signature };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'sweepProfits: fallo en el barrido — se reintentará luego');
    return null;
  }
}
