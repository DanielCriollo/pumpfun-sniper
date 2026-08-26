import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
  SendTransactionError,
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

/** Devuelve el balance de SOL del wallet en SOL (no lamports) */
export async function getSolBalance(): Promise<number> {
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
    return Number(raw / BigInt(10 ** PUMP_TOKEN_DECIMALS));
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
 * Firma (si es necesario) y envía una transacción deserializada.
 * Reintenta hasta MAX_SEND_RETRIES veces ante errores transitorios.
 * Lanza error si supera el límite de intentos.
 */
export async function signAndSendTransaction(
  txBytes: Uint8Array,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      // Intentar deserializar como VersionedTransaction (v0)
      let signature: string;

      try {
        const vtx = VersionedTransaction.deserialize(txBytes);
        vtx.sign([wallet]);
        signature = await connection.sendRawTransaction(vtx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
      } catch {
        // Fallback a transacción legacy
        const tx = Transaction.from(Buffer.from(txBytes));
        tx.partialSign(wallet);
        signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
      }

      // Esperar confirmación
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      const result = await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        'confirmed',
      );

      if (result.value.err) {
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(result.value.err)}`,
        );
      }

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
// Reclaim de renta de cuentas ATA vacías
// -----------------------------------------------------------

/**
 * Cierra la ATA de `mint` si está vacía, recuperando ~0.002 SOL
 * de renta bloqueada de vuelta a la wallet principal.
 * Fire-and-forget seguro: loggea errores sin lanzarlos.
 */
export async function reclaimAtaRent(mint: PublicKey): Promise<void> {
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
