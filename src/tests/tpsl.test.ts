// El orden de imports importa: setupEnv define el entorno ANTES
// de que config.ts (importado transitivamente) lo lea.
import './setupEnv';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideExit,
  updateTrailingSLPhases,
} from '../services/positionManager';
import { Position } from '../types';

// -----------------------------------------------------------
// Tests de la lógica de salidas — el código con más dinero
// en juego. Se simulan secuencias de precios contra las
// funciones puras decideExit y updateTrailingSLPhases.
//
// Parámetros fijados en setupEnv: TP1 +50% (vende 50%),
// TP2 +100% (vende 25%), SL -15%, breakeven +30%,
// trailing +60% (distancia 15%), SL apretado -7% tras 3 min.
// -----------------------------------------------------------

const ENTRY = 30; // mcap de entrada en SOL

function makePosition(overrides: Partial<Position> = {}): Position {
  const pos: Position = {
    mint: 'TESTMINT111111111111111111111111111111111111',
    name: 'Test',
    symbol: 'TEST',
    entryMarketCapSol: ENTRY,
    currentMarketCapSol: ENTRY,
    tokenBalance: 1_000_000,
    initialTokenBalance: 1_000_000,
    solSpent: 0.1,
    solReceived: 0,
    entryTimestamp: Date.now(),
    tp1Hit: false,
    tp2Hit: false,
    status: 'ACTIVE',
    bondingCurveKey: 'curve',
    trades: [],
    // campos que addPosition inicializa en producción
    highWaterMarkMcap: ENTRY,
    breakevenActive: false,
    trailingSLActive: false,
    effectiveSLThreshold: ENTRY * 0.85, // SL fijo -15%
    ...overrides,
  };
  return pos;
}

/** Simula un tick de precio: actualiza mcap, fases de SL y decide */
function tick(pos: Position, mcap: number) {
  pos.currentMarketCapSol = mcap;
  updateTrailingSLPhases(pos);
  return decideExit(pos);
}

// -----------------------------------------------------------
// SL fijo
// -----------------------------------------------------------

test('sin salida entre SL y TP1', () => {
  const pos = makePosition();
  assert.equal(tick(pos, ENTRY * 1.1), null); // +10%: nada
  assert.equal(tick(pos, ENTRY * 0.9), null); // -10%: sobre el SL de -15%
});

test('SL fijo dispara a -15% y vende todo', () => {
  const pos = makePosition();
  const d = tick(pos, ENTRY * 0.84); // -16%
  assert.ok(d);
  assert.equal(d.event, 'SL_TRIGGERED');
  assert.equal(d.tokenAmount, pos.tokenBalance);
});

// -----------------------------------------------------------
// Take profits
// -----------------------------------------------------------

test('TP1 dispara a +50% y vende el 50% del balance inicial', () => {
  const pos = makePosition();
  const d = tick(pos, ENTRY * 1.5);
  assert.ok(d);
  assert.equal(d.event, 'TP1_TRIGGERED');
  assert.equal(d.tokenAmount, 500_000);
});

test('TP1 no repite si ya se ejecutó', () => {
  const pos = makePosition({ tp1Hit: true, tokenBalance: 500_000 });
  const d = tick(pos, ENTRY * 1.55);
  assert.equal(d, null);
});

test('TP2 tiene prioridad si el precio salta directo a +100%', () => {
  const pos = makePosition();
  const d = tick(pos, ENTRY * 2.1);
  assert.ok(d);
  assert.equal(d.event, 'TP2_TRIGGERED');
  assert.equal(d.tokenAmount, 250_000); // 25% del inicial
});

test('TP2 no repite; con tp1 y tp2 ejecutados queda el moonbag sin señal', () => {
  const pos = makePosition({ tp1Hit: true, tp2Hit: true, tokenBalance: 250_000 });
  const d = tick(pos, ENTRY * 2.5);
  assert.equal(d, null);
});

// -----------------------------------------------------------
// Breakeven
// -----------------------------------------------------------

test('a +30% el SL sube a breakeven y protege la entrada', () => {
  const pos = makePosition();
  assert.equal(tick(pos, ENTRY * 1.35), null); // +35%: activa breakeven, sin venta
  assert.equal(pos.breakevenActive, true);
  assert.equal(pos.effectiveSLThreshold, ENTRY);

  // Cae por debajo de la entrada → sale en breakeven, no en -15%
  const d = tick(pos, ENTRY * 0.99);
  assert.ok(d);
  assert.equal(d.event, 'SL_TRIGGERED');
  assert.ok(d.reason.includes('Breakeven'));
});

test('tras TP1 el breakeven queda activo aunque el gain baje', () => {
  // Simula el estado post-TP1 que deja executeSell
  const pos = makePosition({
    tp1Hit: true,
    tokenBalance: 500_000,
    breakevenActive: true,
    effectiveSLThreshold: ENTRY,
  });
  // Recae a +5% (por encima de la entrada): no vende
  assert.equal(tick(pos, ENTRY * 1.05), null);
  // Cae a la entrada: sale protegiendo capital
  const d = tick(pos, ENTRY * 0.995);
  assert.ok(d);
  assert.equal(d.event, 'SL_TRIGGERED');
});

// -----------------------------------------------------------
// Trailing SL
// -----------------------------------------------------------

test('a +70% con TP1 pendiente, TP1 tiene prioridad sobre trailing', () => {
  const pos = makePosition();
  const d = tick(pos, ENTRY * 1.7);
  assert.ok(d);
  assert.equal(d.event, 'TP1_TRIGGERED');
  assert.equal(pos.trailingSLActive, true); // la fase se activó igual
});

test('trailing se activa a +60% y persigue el máximo (HWM)', () => {
  // TPs ya ejecutados para aislar la lógica de trailing (moonbag)
  const pos = makePosition({ tp1Hit: true, tp2Hit: true, tokenBalance: 250_000 });
  assert.equal(tick(pos, ENTRY * 1.7), null); // +70%: trailing activo, sin venta
  assert.equal(pos.trailingSLActive, true);

  // Sube a +150% → HWM sube y el SL lo sigue a -15% del máximo
  assert.equal(tick(pos, ENTRY * 2.5), null);
  const hwm = pos.highWaterMarkMcap ?? 0;
  assert.equal(hwm, ENTRY * 2.5);
  const expectedSL = hwm * 0.85;
  assert.ok(Math.abs((pos.effectiveSLThreshold ?? 0) - expectedSL) < 1e-9);

  // Retrocede 10% desde el máximo: no vende
  assert.equal(tick(pos, hwm * 0.9), null);
  // Retrocede 16% desde el máximo: trailing dispara
  const d = tick(pos, hwm * 0.84);
  assert.ok(d);
  assert.equal(d.event, 'SL_TRIGGERED');
  assert.ok(d.reason.includes('Trailing'));
});

test('el trailing nunca baja el umbral aunque el precio caiga', () => {
  const pos = makePosition({ tp1Hit: true, tp2Hit: true });
  tick(pos, ENTRY * 2.0); // HWM = 60, SL = 51
  const slBefore = pos.effectiveSLThreshold ?? 0;
  tick(pos, ENTRY * 1.8); // retrocede (sigue > SL)
  assert.equal(pos.effectiveSLThreshold, slBefore); // el umbral no retrocede
});

// -----------------------------------------------------------
// SL apretado por tiempo
// -----------------------------------------------------------

test('tras 3 min sin TP el SL se aprieta de -15% a -7%', () => {
  const pos = makePosition({
    entryTimestamp: Date.now() - 4 * 60_000, // hace 4 min
  });
  // A -5% no vende, pero el umbral ya subió a -7%
  assert.equal(tick(pos, ENTRY * 0.95), null);
  const expected = ENTRY * 0.93;
  assert.ok(Math.abs((pos.effectiveSLThreshold ?? 0) - expected) < 1e-9);

  // A -8% ya dispara (con el SL original de -15% no habría vendido)
  const d = tick(pos, ENTRY * 0.92);
  assert.ok(d);
  assert.equal(d.event, 'SL_TRIGGERED');
});

test('el SL apretado no aplica si el breakeven ya está activo', () => {
  const pos = makePosition({
    entryTimestamp: Date.now() - 10 * 60_000,
    breakevenActive: true,
    effectiveSLThreshold: ENTRY,
  });
  tick(pos, ENTRY * 1.05);
  // El umbral sigue siendo la entrada (breakeven), no -7%
  assert.equal(pos.effectiveSLThreshold, ENTRY);
});
