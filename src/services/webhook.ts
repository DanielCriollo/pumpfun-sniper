import { config } from '../config';
import { logger } from '../logger';
import { WebhookPayload } from '../types';

// -----------------------------------------------------------
// Dispatcher de Webhooks hacia n8n — Módulo D (parte 1)
// -----------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

/** Espera N ms */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Envía un evento HTTP POST al webhook de n8n con reintentos
 * en backoff lineal. El error no se propaga al llamador
 * (fire-and-forget con best-effort): el bot no debe crashear
 * por fallos de notificación.
 */
export async function sendWebhook(payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000); // 8 s

      let response: Response;
      try {
        response = await fetch(config.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Header de autenticación compartido con n8n
            'X-Webhook-Secret': config.N8N_WEBHOOK_SECRET,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(
          `Webhook HTTP ${response.status}: ${await response.text().catch(() => '')}`,
        );
      }

      logger.debug(
        { event: payload.event, mint: payload.mint },
        '📡 Webhook enviado a n8n',
      );
      return; // Éxito → salir del loop
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isLast = attempt === MAX_RETRIES;

      if (isLast) {
        // Registrar el fallo sin lanzar excepción (best-effort)
        logger.error(
          { event: payload.event, mint: payload.mint, err: errMsg },
          '❌ Webhook fallido tras todos los intentos',
        );
        return;
      }

      logger.warn(
        { event: payload.event, attempt, err: errMsg },
        `Reintentando webhook (${attempt}/${MAX_RETRIES})…`,
      );
      await sleep(BASE_RETRY_DELAY_MS * attempt);
    }
  }
}
