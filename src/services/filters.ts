import { PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../logger';
import { connection } from './solana';
import { FilterResult, NewTokenEvent, TokenMetadata } from '../types';

// -----------------------------------------------------------
// Filtros Anti-Rug — Módulo A
// -----------------------------------------------------------

/** Puntuación parcial asignada a cada check que pasa */
const SCORE_DEV_BUY = 40;
const SCORE_SOL_AMOUNT = 30;
const SCORE_SOCIAL_LINKS = 30;

// -----------------------------------------------------------
// Registro local de creadores — gratis (sin RPC)
// -----------------------------------------------------------
// El bot ve TODOS los `create` por el WS, así que puede detectar
// devs que lanzan tokens en serie (patrón clásico de rug factory).

const creatorCreations = new Map<string, number[]>();
const DAY_MS = 24 * 60 * 60 * 1000;

/** Timeout duro para llamadas RPC de filtros — una RPC colgada no debe
 *  bloquear el slot de compra indefinidamente (fail-open) */
const FILTER_RPC_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms);
      t.unref();
    }),
  ]);
}

/** Registrar cada evento `create` visto, pase o no los filtros */
export function registerTokenCreation(creator: string): void {
  const cutoff = Date.now() - DAY_MS;
  const recent = (creatorCreations.get(creator) ?? []).filter((t) => t >= cutoff);
  recent.push(Date.now());
  creatorCreations.set(creator, recent);
}

/** Purga entradas viejas del registro (llamar periódicamente) */
export function pruneCreatorRegistry(): void {
  const cutoff = Date.now() - DAY_MS;
  for (const [creator, times] of creatorCreations) {
    const recent = times.filter((t) => t >= cutoff);
    if (recent.length === 0) creatorCreations.delete(creator);
    else creatorCreations.set(creator, recent);
  }
}

/**
 * Check local: ¿este dev ya creó demasiados tokens en 24h?
 * (el token actual ya está registrado, por eso se compara con >)
 */
export function checkCreatorLocal(creator: string): FilterResult {
  const cutoff = Date.now() - DAY_MS;
  const count = (creatorCreations.get(creator) ?? []).filter((t) => t >= cutoff).length;
  if (count > config.CREATOR_MAX_TOKENS_PER_DAY) {
    return {
      passed: false,
      reason: `Dev creó ${count} tokens en 24h (máx. ${config.CREATOR_MAX_TOKENS_PER_DAY}) — patrón de rug en serie`,
      score: 0,
    };
  }
  return { passed: true, score: 0 };
}

/**
 * Check RPC: historial on-chain de la wallet del creador.
 * Una wallet con cientos de txs creando tokens es un operador
 * en serie, no un proyecto. Fail-open: si la RPC falla, no bloquea.
 */
export async function checkCreatorHistory(creator: string): Promise<FilterResult> {
  if (!config.CHECK_CREATOR_HISTORY) return { passed: true, score: 0 };
  try {
    const sigs = await withTimeout(
      connection.getSignaturesForAddress(
        new PublicKey(creator),
        { limit: config.CREATOR_HISTORY_MAX_TXS },
        'confirmed',
      ),
      FILTER_RPC_TIMEOUT_MS,
      'checkCreatorHistory',
    );
    if (sigs.length >= config.CREATOR_HISTORY_MAX_TXS) {
      return {
        passed: false,
        reason: `Wallet del dev hiperactiva: >=${config.CREATOR_HISTORY_MAX_TXS} txs en el historial`,
        score: 0,
      };
    }
    logger.debug({ creator, txCount: sigs.length }, 'Check creatorHistory ✓');
    return { passed: true, score: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ creator, err: msg }, 'checkCreatorHistory: fallo RPC — dejando pasar (fail-open)');
    return { passed: true, score: 0 };
  }
}

// -----------------------------------------------------------
// Check de concentración de holders (post-observación)
// -----------------------------------------------------------
// Si una sola wallet (fuera de la bonding curve) acumuló un % alto
// del supply en los primeros segundos, es el equipo posicionado
// para dumpear. Se ejecuta DESPUÉS de la ventana de observación,
// cuando ya existen holders que evaluar.

export async function checkHolderConcentration(mint: string): Promise<FilterResult> {
  if (config.MAX_HOLDER_PERCENT <= 0) return { passed: true, score: 0 };
  try {
    const res = await withTimeout(
      connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed'),
      FILTER_RPC_TIMEOUT_MS,
      'checkHolderConcentration',
    );
    // Ordenados desc — el mayor es (casi siempre) la bonding curve: se omite
    const holders = res.value.slice(1);
    for (const h of holders) {
      const ui = h.uiAmount ?? 0;
      const pct = (ui / config.PUMP_TOTAL_SUPPLY) * 100;
      if (pct > config.MAX_HOLDER_PERCENT) {
        return {
          passed: false,
          reason: `Holder con ${pct.toFixed(1)}% del supply (máx. ${config.MAX_HOLDER_PERCENT}%) — riesgo de dump`,
          score: 0,
        };
      }
    }
    logger.debug({ mint, holders: holders.length }, 'Check holderConcentration ✓');
    return { passed: true, score: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ mint, err: msg }, 'checkHolderConcentration: fallo RPC — dejando pasar (fail-open)');
    return { passed: true, score: 0 };
  }
}

// -----------------------------------------------------------
// Check 1: El dev no compró más del % máximo del supply
// -----------------------------------------------------------
function checkDevBuyPercent(event: NewTokenEvent): FilterResult {
  const devBuyPercent =
    (event.tokenAmount / config.PUMP_TOTAL_SUPPLY) * 100;

  if (devBuyPercent > config.MAX_DEV_BUY_PERCENT) {
    return {
      passed: false,
      reason: `Dev compró ${devBuyPercent.toFixed(2)}% del supply (máx. ${config.MAX_DEV_BUY_PERCENT}%)`,
      score: 0,
    };
  }

  logger.debug(
    { devBuyPercent: devBuyPercent.toFixed(2), mint: event.mint },
    'Check devBuyPercent ✓',
  );
  return { passed: true, score: SCORE_DEV_BUY };
}

// -----------------------------------------------------------
// Check 2: SOL inicial del dev en rango de seguridad
// -----------------------------------------------------------
function checkDevSolAmount(event: NewTokenEvent): FilterResult {
  const sol = event.solAmount;

  if (sol <= 0 || sol < config.MIN_DEV_SOL_AMOUNT) {
    return {
      passed: false,
      reason: `solAmount del dev demasiado bajo: ${sol} SOL`,
      score: 0,
    };
  }

  if (sol > config.MAX_DEV_SOL_AMOUNT) {
    return {
      passed: false,
      reason: `solAmount del dev demasiado alto: ${sol} SOL (máx. ${config.MAX_DEV_SOL_AMOUNT})`,
      score: 0,
    };
  }

  logger.debug(
    { sol, mint: event.mint },
    'Check devSolAmount ✓',
  );
  return { passed: true, score: SCORE_SOL_AMOUNT };
}

// -----------------------------------------------------------
// Check 3: Metadatos con al menos un link social
// -----------------------------------------------------------
async function checkSocialLinks(event: NewTokenEvent): Promise<FilterResult> {
  if (!config.REQUIRE_SOCIAL_LINKS) {
    // Si el check está desactivado, conceder puntuación completa
    return { passed: true, score: SCORE_SOCIAL_LINKS };
  }

  if (!event.uri || event.uri.trim() === '') {
    return {
      passed: false,
      reason: 'URI de metadatos vacío',
      score: 0,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.METADATA_TIMEOUT_MS,
    );

    let metadata: TokenMetadata;
    try {
      const res = await fetch(event.uri, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        return {
          passed: false,
          reason: `URI de metadatos devolvió ${res.status}`,
          score: 0,
        };
      }
      metadata = (await res.json()) as TokenMetadata;
    } finally {
      clearTimeout(timeout);
    }

    // Regex: exige handle real (mínimo 3 chars) — rechaza URLs genéricas sin path
    const twitterRe = /(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{3,})/;
    const telegramRe = /t\.me\/([a-zA-Z0-9_]{3,})/;

    const rawTwitter  = typeof metadata.twitter  === 'string' ? metadata.twitter.trim()  : '';
    const rawTelegram = typeof metadata.telegram  === 'string' ? metadata.telegram.trim() : '';
    const rawWebsite  = typeof metadata.website   === 'string' ? metadata.website.trim()  : '';

    const hasTwitter  = twitterRe.test(rawTwitter);
    const hasTelegram = telegramRe.test(rawTelegram);
    const hasWebsite  = rawWebsite.length > 10 && rawWebsite.startsWith('http');

    const hasSocialLink = hasTwitter || hasTelegram || hasWebsite;

    if (!hasSocialLink) {
      const detail = [
        rawTwitter  ? `twitter="${rawTwitter}"`  : '',
        rawTelegram ? `telegram="${rawTelegram}"` : '',
        rawWebsite  ? `website="${rawWebsite}"`   : '',
      ].filter(Boolean).join(', ') || 'sin campos sociales';
      return {
        passed: false,
        reason: `Links sociales inválidos o genéricos (${detail})`,
        score: 0,
      };
    }

    logger.debug(
      { mint: event.mint, hasTwitter, hasTelegram, hasWebsite },
      'Check socialLinks ✓',
    );
    return { passed: true, score: SCORE_SOCIAL_LINKS };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      reason: `Error al fetchear metadatos: ${msg}`,
      score: 0,
    };
  }
}

// -----------------------------------------------------------
// Orquestador de filtros
// -----------------------------------------------------------

/**
 * Aplica todos los filtros anti-rug al evento de nuevo token.
 * Devuelve el primer fallo encontrado o un resultado positivo
 * con la puntuación de seguridad acumulada.
 *
 * Los checks se ejecutan de menor a mayor costo:
 *  1. devBuyPercent (cálculo local, <1 ms)
 *  2. devSolAmount  (cálculo local, <1 ms)
 *  3. socialLinks   (fetch remoto, ~100-3000 ms)
 */
export async function applyFilters(
  event: NewTokenEvent,
): Promise<FilterResult> {
  // Check 1 — sin costo de red
  const r1 = checkDevBuyPercent(event);
  if (!r1.passed) {
    logger.info(
      { mint: event.mint, reason: r1.reason },
      '🚫 Filtro RECHAZADO [devBuyPercent]',
    );
    return r1;
  }

  // Check 2 — sin costo de red
  const r2 = checkDevSolAmount(event);
  if (!r2.passed) {
    logger.info(
      { mint: event.mint, reason: r2.reason },
      '🚫 Filtro RECHAZADO [devSolAmount]',
    );
    return r2;
  }

  // Check 3 — fetch remoto (más lento, se ejecuta al final)
  const r3 = await checkSocialLinks(event);
  if (!r3.passed) {
    logger.info(
      { mint: event.mint, reason: r3.reason },
      '🚫 Filtro RECHAZADO [socialLinks]',
    );
    return r3;
  }

  const totalScore = r1.score + r2.score + r3.score;
  logger.info(
    {
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      marketCapSol: event.marketCapSol,
      score: totalScore,
    },
    '✅ Filtros PASADOS — token apto para compra',
  );

  return { passed: true, score: totalScore };
}
