import WebSocket from 'ws';

// -----------------------------------------------------------
// Estado mutable compartido del bot (singleton)
// Centralizado aquí para evitar importaciones circulares
// entre index.ts ↔ server.ts ↔ positionManager.ts
// -----------------------------------------------------------

interface BotState {
  /** El bot no acepta nuevas compras cuando es true */
  isPaused: boolean;

  /** WebSocket activo hacia PumpPortal */
  wsInstance: WebSocket | null;

  /** Número de intentos de reconexión consecutivos */
  reconnectAttempts: number;

  /** Mints suscritos a subscribeTokenTrade */
  subscribedMints: Set<string>;
}

export const state: BotState = {
  isPaused: false,
  wsInstance: null,
  reconnectAttempts: 0,
  subscribedMints: new Set(),
};

// -----------------------------------------------------------
// Mutadores tipados
// -----------------------------------------------------------

export function setWsInstance(ws: WebSocket | null): void {
  state.wsInstance = ws;
}

export function setPaused(paused: boolean): void {
  state.isPaused = paused;
}

export function incrementReconnects(): void {
  state.reconnectAttempts++;
}

export function resetReconnects(): void {
  state.reconnectAttempts = 0;
}

/**
 * Envía la suscripción al WebSocket activo.
 * Si el WS no está abierto, añade el mint al Set
 * para re-suscribir cuando se reconecte.
 */
export function subscribeToMintTrades(mint: string): void {
  state.subscribedMints.add(mint);
  if (
    state.wsInstance &&
    state.wsInstance.readyState === WebSocket.OPEN
  ) {
    state.wsInstance.send(
      JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }),
    );
  }
}
