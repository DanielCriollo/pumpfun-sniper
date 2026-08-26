import { config } from '../config';
import { logger } from '../logger';
import { NewTokenEvent, TradeEvent } from '../types';
import { wallet } from './solana';

// -----------------------------------------------------------
// Ventana de Observación de Entrada
// -----------------------------------------------------------
// En lugar de comprar a ciegas en el evento `create`, se observan
// los primeros ENTRY_OBSERVATION_SECONDS del token:
//   - ¿cuántos compradores únicos entraron? (tracción real)
//   - ¿vendió el dev? (señal de rug inmediato → abortar al instante)
//   - ¿el mcap sube o se está desinflando?
// Solo se compra si el token muestra tracción genuina.
// -----------------------------------------------------------

export interface ObservationResult {
  passed: boolean;
  reason?: string;
  uniqueBuyers: number;
  buyCount: number;
  sellCount: number;
  /** Último mcap visto durante la ventana — mejor estimación del precio de entrada */
  finalMcap: number;
  /** SOL en la bonding curve al cierre de la ventana (liquidez ejecutable) */
  finalVSol: number;
}

interface Observation {
  creator: string;
  startMcap: number;
  lastMcap: number;
  lastVSol: number;
  buyers: Set<string>;
  buyCount: number;
  sellCount: number;
  finish: (result: ObservationResult) => void;
}

const observations = new Map<string, Observation>();

export function isUnderObservation(mint: string): boolean {
  return observations.has(mint);
}

/**
 * Observa el mint durante ENTRY_OBSERVATION_SECONDS y resuelve con el
 * veredicto. El llamador debe haberse suscrito ya a los trades del mint
 * y encargarse de desuscribirse si el resultado es negativo.
 */
export function observeToken(event: NewTokenEvent): Promise<ObservationResult> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;

    const obs: Observation = {
      creator: event.traderPublicKey,
      startMcap: event.marketCapSol,
      lastMcap: event.marketCapSol,
      lastVSol: event.vSolInBondingCurve ?? 0,
      buyers: new Set<string>(),
      buyCount: 0,
      sellCount: 0,
      finish: (result) => {
        clearTimeout(timer);
        observations.delete(event.mint);
        resolve(result);
      },
    };

    timer = setTimeout(
      () => evaluateObservation(event.mint),
      config.ENTRY_OBSERVATION_SECONDS * 1000,
    );

    observations.set(event.mint, obs);
    logger.debug(
      { mint: event.mint, symbol: event.symbol, windowSec: config.ENTRY_OBSERVATION_SECONDS },
      '👀 Observando token antes de decidir entrada',
    );
  });
}

/** Veredicto al cierre de la ventana */
function evaluateObservation(mint: string): void {
  const obs = observations.get(mint);
  if (!obs) return;

  const base = {
    uniqueBuyers: obs.buyers.size,
    buyCount: obs.buyCount,
    sellCount: obs.sellCount,
    finalMcap: obs.lastMcap,
    finalVSol: obs.lastVSol,
  };

  // Liquidez ejecutable: la curva arranca con ~30 SOL virtuales, así que
  // vSol 33 ≈ solo 3 SOL reales. Un mcap alto con curva vacía es ilusorio:
  // nuestra propia venta se comería el precio (lección del trade "Bul").
  if (config.MIN_VSOL_IN_CURVE > 0 && obs.lastVSol < config.MIN_VSOL_IN_CURVE) {
    obs.finish({
      passed: false,
      reason: `Liquidez real insuficiente: ${obs.lastVSol.toFixed(1)} vSOL en curva (mín. ${config.MIN_VSOL_IN_CURVE})`,
      ...base,
    });
    return;
  }

  if (obs.buyers.size < config.MIN_UNIQUE_BUYERS) {
    obs.finish({
      passed: false,
      reason: `Solo ${obs.buyers.size} compradores únicos en ${config.ENTRY_OBSERVATION_SECONDS}s (mín. ${config.MIN_UNIQUE_BUYERS})`,
      ...base,
    });
    return;
  }

  if (obs.lastMcap <= obs.startMcap) {
    obs.finish({
      passed: false,
      reason: `Sin momentum: mcap ${obs.lastMcap.toFixed(2)} SOL ≤ inicial ${obs.startMcap.toFixed(2)} SOL`,
      ...base,
    });
    return;
  }

  if (config.MAX_ENTRY_MCAP_SOL > 0 && obs.lastMcap > config.MAX_ENTRY_MCAP_SOL) {
    obs.finish({
      passed: false,
      reason: `Mcap ${obs.lastMcap.toFixed(2)} SOL superó el máximo de entrada (${config.MAX_ENTRY_MCAP_SOL}) durante la observación`,
      ...base,
    });
    return;
  }

  obs.finish({ passed: true, ...base });
}

/**
 * Alimenta la observación con un trade del stream.
 * Devuelve true si el evento pertenece a un mint bajo observación
 * (y por tanto no debe seguir hacia el position manager).
 */
export function handleObservationTrade(event: TradeEvent): boolean {
  const obs = observations.get(event.mint);
  if (!obs) return false;

  obs.lastMcap = event.marketCapSol;
  if (typeof event.vSolInBondingCurve === 'number') {
    obs.lastVSol = event.vSolInBondingCurve;
  }

  // Dev vendiendo durante la ventana = rug inminente → abortar al instante
  if (event.txType === 'sell' && event.traderPublicKey === obs.creator) {
    obs.finish({
      passed: false,
      reason: `Dev vendió ${event.solAmount.toFixed(3)} SOL durante la ventana de observación`,
      uniqueBuyers: obs.buyers.size,
      buyCount: obs.buyCount,
      sellCount: obs.sellCount,
      finalMcap: obs.lastMcap,
      finalVSol: obs.lastVSol,
    });
    return true;
  }

  if (event.txType === 'buy') {
    obs.buyCount++;
    const me = wallet.publicKey.toBase58();
    if (event.traderPublicKey !== obs.creator && event.traderPublicKey !== me) {
      obs.buyers.add(event.traderPublicKey);
    }
  } else {
    obs.sellCount++;
  }

  return true;
}
