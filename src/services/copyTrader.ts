import { config } from '../config';
import { logger } from '../logger';
import { state, subscribeToMintTrades, unsubscribeMintTrades } from '../state';
import { TradeEvent, Position } from '../types';
import { buyToken, BuyResult } from './pumpfun';
import { getSolBalance } from './solana';
import {
  addPosition,
  getActivePositionCount,
  hasActivePosition,
  executeSignalExit,
} from './positionManager';
import { sendWebhook } from './webhook';

// -----------------------------------------------------------
// Copy Trader — espejo de wallets ganadoras
// -----------------------------------------------------------
// Sigue las wallets de COPY_WALLETS vía subscribeAccountTrade:
//   - La wallet seguida COMPRA (>= COPY_MIN_BUY_SOL) → el bot compra.
//   - La wallet seguida VENDE ese token → el bot sale COMPLETO.
// Las posiciones copy conservan TODAS las protecciones propias
// (SL, trailing, volumen muerto, tiempo máximo, breaker) como
// respaldo: si la wallet copiada se queda atrapada, nosotros no.
//
// ⚠️ La calidad de este modo depende 100% de QUÉ wallets sigues.
// Usa `npm run topwallets` para minar candidatas de tu firehose
// y valídalas en Solscan antes de agregarlas al .env.
// -----------------------------------------------------------

const copyWallets = new Set(config.COPY_WALLETS);

/** Mints con compra copy en vuelo */
const inFlight = new Set<string>();
/** SOL comprometido por compras copy en vuelo */
let reservedSol = 0;

export function isCopyWallet(pubkey: string): boolean {
  return copyWallets.size > 0 && copyWallets.has(pubkey);
}

export function copyWalletCount(): number {
  return copyWallets.size;
}

function shortKey(k: string): string {
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export async function handleCopySignal(event: TradeEvent): Promise<void> {
  const followed = event.traderPublicKey;
  const short = shortKey(followed);

  // -----------------------------------------------------------------
  // VENTA de la wallet seguida → salir de nuestra posición en ese mint
  // -----------------------------------------------------------------
  if (event.txType === 'sell') {
    await executeSignalExit(
      event.mint,
      'COPY_SELL_EXIT',
      `Wallet copiada ${short} vendió ${event.solAmount.toFixed(3)} SOL`,
    );
    return;
  }

  // -----------------------------------------------------------------
  // COMPRA de la wallet seguida → espejar
  // -----------------------------------------------------------------
  if (state.isPaused) return;

  // Compras pequeñas de la wallet seguida = ruido (tests, dust, spam)
  if (event.solAmount < config.COPY_MIN_BUY_SOL) {
    logger.debug(
      { mint: event.mint, wallet: short, buySol: event.solAmount },
      'Señal copy ignorada: compra bajo el mínimo',
    );
    return;
  }

  if (hasActivePosition(event.mint) || inFlight.has(event.mint)) return;

  if (getActivePositionCount() + inFlight.size >= config.MAX_CONCURRENT_POSITIONS) {
    logger.debug({ mint: event.mint }, 'Señal copy ignorada: límite de posiciones');
    return;
  }

  // Liquidez real mínima (mismo criterio que el sniper)
  if (
    config.MIN_VSOL_IN_CURVE > 0 &&
    typeof event.vSolInBondingCurve === 'number' &&
    event.vSolInBondingCurve > 0 &&
    event.vSolInBondingCurve < config.MIN_VSOL_IN_CURVE
  ) {
    logger.info(
      { mint: event.mint, wallet: short, vSol: event.vSolInBondingCurve.toFixed(1) },
      '👣 Señal copy rechazada: liquidez real insuficiente',
    );
    return;
  }

  logger.info(
    {
      mint: event.mint,
      wallet: short,
      buySol: event.solAmount,
      mcap: event.marketCapSol?.toFixed(2),
    },
    '👣 Señal de COPY: wallet seguida compró — espejando',
  );

  inFlight.add(event.mint);
  try {
    const solBalance = await getSolBalance();
    const available = solBalance - reservedSol;
    const buyAmount =
      config.DYNAMIC_BUY_PERCENT > 0
        ? Math.max(available * (config.DYNAMIC_BUY_PERCENT / 100), 0.001)
        : config.BUY_AMOUNT_SOL;

    if (available < buyAmount + config.MIN_SOL_RESERVE) {
      logger.warn(
        { solBalance, reservedSol, required: buyAmount },
        '⚠️  Copy: balance insuficiente — reserva mínima protegida',
      );
      return;
    }

    reservedSol += buyAmount;
    let buyResult: BuyResult;
    try {
      buyResult = await buyToken(event.mint, buyAmount, event.marketCapSol);
    } finally {
      reservedSol -= buyAmount;
    }

    const entryMcap =
      buyResult.tokenBalance >= 1
        ? (buyAmount / buyResult.tokenBalance) * config.PUMP_TOTAL_SUPPLY
        : event.marketCapSol;

    const position: Position = {
      mint: event.mint,
      name: `COPY de ${short}`,
      symbol: event.mint.slice(0, 6),
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
      bondingCurveKey: event.bondingCurveKey ?? '',
      strategy: 'copy',
      copiedFrom: followed,
      trades: [
        {
          timestamp: Date.now(),
          action: 'BUY' as const,
          tokenAmount: buyResult.tokenBalance,
          solAmount: buyAmount,
          marketCapSol: entryMcap,
          signature: buyResult.signature,
          reason: `Copy: ${short} compró ${event.solAmount.toFixed(3)} SOL`,
        },
      ],
    };

    addPosition(position);
    subscribeToMintTrades(event.mint);

    await sendWebhook({
      event: 'TOKEN_BOUGHT',
      mint: event.mint,
      name: position.name,
      symbol: position.symbol,
      marketCapSol: entryMcap,
      solAmount: buyAmount,
      tokenAmount: buyResult.tokenBalance,
      signature: buyResult.signature,
      timestamp: Date.now(),
      extra: { strategy: 'copy', copiedFrom: followed, followedBuySol: event.solAmount },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ mint: event.mint, err: errMsg }, '❌ Error en compra copy');
    await sendWebhook({
      event: 'TRADE_ERROR',
      mint: event.mint,
      error: `copy: ${errMsg}`,
      timestamp: Date.now(),
    });
  } finally {
    inFlight.delete(event.mint);
    if (!hasActivePosition(event.mint)) {
      unsubscribeMintTrades(event.mint);
    }
  }
}
