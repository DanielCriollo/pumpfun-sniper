import { config } from '../config';
import { logger } from '../logger';
import { FilterResult, NewTokenEvent, TokenMetadata } from '../types';

// -----------------------------------------------------------
// Filtros Anti-Rug — Módulo A
// -----------------------------------------------------------

/** Puntuación parcial asignada a cada check que pasa */
const SCORE_DEV_BUY = 40;
const SCORE_SOL_AMOUNT = 30;
const SCORE_SOCIAL_LINKS = 30;

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
