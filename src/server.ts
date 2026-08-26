import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { logger } from './logger';
import { state, setPaused } from './state';
import { executePanicSell, getPosition, getAllPositions } from './services/positionManager';
import { getDailyStats, resetBreaker } from './services/riskManager';
import { ApiResponse } from './types';

// -----------------------------------------------------------
// Servidor HTTP interno — Módulo D (parte 2)
// -----------------------------------------------------------
// Expone dos endpoints de control que pueden ser llamados
// desde n8n (VPS 2) o directamente con curl.
//
// Autenticación: header "X-Api-Key: <API_SECRET_KEY>"
// -----------------------------------------------------------

const server = Fastify({
  logger: false, // Usamos pino directamente para logs consistentes
  trustProxy: true,
});

// -----------------------------------------------------------
// Plugin: Rate Limiting (protección básica ante bucles)
// -----------------------------------------------------------
void server.register(rateLimit, {
  global: true,
  max: 30,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({
    success: false,
    error: 'Too many requests',
  }),
});

// -----------------------------------------------------------
// Hook de autenticación por API Key
// -----------------------------------------------------------
server.addHook(
  'preHandler',
  async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey || apiKey !== config.API_SECRET_KEY) {
      logger.warn(
        { ip: request.ip, url: request.url },
        '🔒 Petición rechazada: API key inválida',
      );
      const body: ApiResponse = { success: false, error: 'Unauthorized' };
      await reply.status(401).send(body);
    }
  },
);

// -----------------------------------------------------------
// POST /api/panic-sell/:mint
// Liquida inmediatamente el 100% de la posición del mint.
// -----------------------------------------------------------
server.post<{ Params: { mint: string } }>(
  '/api/panic-sell/:mint',
  async (request, reply) => {
    const { mint } = request.params;

    logger.warn({ mint, ip: request.ip }, '🚨 PANIC SELL solicitado');

    try {
      await executePanicSell(mint);
      const body: ApiResponse = {
        success: true,
        data: { mint, message: 'Panic sell ejecutado con éxito' },
      };
      return reply.status(200).send(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ mint, err: errMsg }, 'Error en panic sell');
      const body: ApiResponse = { success: false, error: errMsg };
      return reply.status(400).send(body);
    }
  },
);

// -----------------------------------------------------------
// POST /api/toggle-pause
// Alterna entre modo pausado y activo para nuevas compras.
// -----------------------------------------------------------
server.post('/api/toggle-pause', async (request, reply) => {
  const newState = !state.isPaused;
  setPaused(newState);

  // Al reanudar manualmente, re-armar el circuit breaker para que
  // las protecciones vuelvan a estar activas
  if (!newState) resetBreaker();

  logger.info(
    { ip: request.ip, isPaused: newState },
    newState ? '⏸  Bot PAUSADO' : '▶️  Bot REANUDADO',
  );

  const body: ApiResponse = {
    success: true,
    data: {
      isPaused: newState,
      message: newState
        ? 'Bot pausado: no se aceptarán nuevas compras'
        : 'Bot reanudado: aceptando nuevas compras',
    },
  };
  return reply.status(200).send(body);
});

// -----------------------------------------------------------
// GET /api/status — Panel de estado rápido
// -----------------------------------------------------------
server.get('/api/status', async (_request, reply) => {
  const activePositions = getAllPositions().filter((p) => p.status === 'ACTIVE');
  const daily = getDailyStats();

  const body: ApiResponse = {
    success: true,
    data: {
      mode: config.DRY_RUN ? 'DRY_RUN' : 'REAL',
      isPaused: state.isPaused,
      wsConnected: state.wsInstance !== null,
      daily: {
        date: daily.date,
        realizedPnlSol: parseFloat(daily.realizedPnlSol.toFixed(6)),
        trades: daily.trades,
        wins: daily.wins,
        losses: daily.losses,
        consecutiveLosses: daily.consecutiveLosses,
        circuitBreakerTripped: daily.breakerTripped,
        circuitBreakerReason: daily.breakerReason ?? null,
      },
      activePositions: activePositions.length,
      positions: activePositions.map((p) => ({
        mint: p.mint,
        name: p.name,
        symbol: p.symbol,
        entryMcap: p.entryMarketCapSol,
        currentMcap: p.currentMarketCapSol,
        multiplier:
          (p.currentMarketCapSol / p.entryMarketCapSol).toFixed(2) + 'x',
        tokenBalance: p.tokenBalance,
        tp1Hit: p.tp1Hit,
        tp2Hit: p.tp2Hit,
      })),
    },
  };
  return reply.status(200).send(body);
});

// -----------------------------------------------------------
// GET /api/position/:mint — Detalle de una posición
// -----------------------------------------------------------
server.get<{ Params: { mint: string } }>(
  '/api/position/:mint',
  async (request, reply) => {
    const { mint } = request.params;
    const position = getPosition(mint);

    if (!position) {
      const body: ApiResponse = {
        success: false,
        error: `No se encontró posición para mint: ${mint}`,
      };
      return reply.status(404).send(body);
    }

    const body: ApiResponse = { success: true, data: position };
    return reply.status(200).send(body);
  },
);

// -----------------------------------------------------------
// Arranque del servidor
// -----------------------------------------------------------
export async function startServer(): Promise<void> {
  await server.listen({
    port: config.API_PORT,
    host: '127.0.0.1', // Solo loopback: exponer via nginx/ssh tunnel si necesitas
  });
  logger.info(
    { port: config.API_PORT },
    `🌐 API interna escuchando en 127.0.0.1:${config.API_PORT}`,
  );
}

export { server };
