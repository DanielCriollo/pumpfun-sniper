import fs from 'fs';
import nodePath from 'path';

// -----------------------------------------------------------
// Reporte de rendimiento — npm run report
// -----------------------------------------------------------
// Lee data/closed-positions.jsonl, data/stats.json y
// data/rejections.jsonl y responde la pregunta que importa:
// ¿qué condiciones están ganando dinero y cuáles lo pierden?
//
// Standalone: NO importa config (no necesita .env) — solo lee
// los archivos de datos. Ejecutar tras `npm run build`:
//   node dist/tools/report.js
// -----------------------------------------------------------

interface ClosedPosition {
  mint: string;
  symbol: string;
  solSpent: number;
  solReceived?: number;
  realizedPnlSol?: number;
  entryTimestamp: number;
  exitEvent?: string;
  strategy?: string;
  copiedFrom?: string;
  entryContext?: {
    uniqueBuyers?: number;
    devBuyPercent?: number;
    devSolAmount?: number;
    createMcapSol?: number;
    entryMcapSol?: number;
    hourUtc?: number;
  };
  trades?: { timestamp: number; action: string }[];
}

interface Rejection {
  t: number;
  mint: string;
  symbol?: string;
  reason: string;
}

const DATA_DIR = nodePath.join(process.cwd(), 'data');

function readJsonl<T>(file: string): T[] {
  const full = nodePath.join(DATA_DIR, file);
  if (!fs.existsSync(full)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* línea corrupta — ignorar */
    }
  }
  return out;
}

const sol = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

interface Bucket {
  n: number;
  wins: number;
  pnl: number;
}

function bucketAdd(map: Map<string, Bucket>, key: string, pnl: number): void {
  const b = map.get(key) ?? { n: 0, wins: 0, pnl: 0 };
  b.n++;
  if (pnl > 0) b.wins++;
  b.pnl += pnl;
  map.set(key, b);
}

function printBuckets(title: string, map: Map<string, Bucket>, sortByPnl = true): void {
  if (map.size === 0) return;
  console.log(`\n── ${title} ${'─'.repeat(Math.max(1, 58 - title.length))}`);
  const rows = Array.from(map.entries());
  if (sortByPnl) rows.sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [key, b] of rows) {
    const wr = b.n > 0 ? pct(b.wins / b.n) : '-';
    console.log(
      `  ${key.padEnd(34)} n=${String(b.n).padStart(4)}  winrate=${wr.padStart(4)}  pnl=${sol(b.pnl)}`,
    );
  }
}

/** Agrupa las razones de rechazo en categorías legibles */
function rejectionCategory(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('compradores únicos')) return 'observación: pocos compradores';
  if (r.includes('sin momentum')) return 'observación: sin momentum';
  if (r.includes('dev vendió')) return 'observación: dev vendió';
  if (r.includes('hiperactiva')) return 'creador: wallet hiperactiva';
  if (r.includes('tokens en 24h')) return 'creador: en serie (24h)';
  if (r.includes('links sociales') || r.includes('uri de metadatos') || r.includes('metadatos'))
    return 'metadatos/sociales';
  if (r.includes('solamount del dev')) return 'dev: solAmount fuera de rango';
  if (r.includes('dev compró')) return 'dev: % del supply alto';
  if (r.includes('holder')) return 'holders: concentración';
  if (r.includes('mcap')) return 'mcap de entrada';
  return 'otros';
}

function main(): void {
  console.log('════════════════════════════════════════════════════════════');
  console.log('  PUMPFUN SNIPER — REPORTE DE RENDIMIENTO');
  console.log('════════════════════════════════════════════════════════════');

  // ---------- Posiciones cerradas ----------
  const closed = readJsonl<ClosedPosition>('closed-positions.jsonl');

  if (closed.length === 0) {
    console.log('\nSin posiciones cerradas todavía (data/closed-positions.jsonl vacío).');
  } else {
    const pnls = closed.map((p) => p.realizedPnlSol ?? 0);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const sumWins = wins.reduce((a, b) => a + b, 0);
    const sumLosses = losses.reduce((a, b) => a + b, 0);
    const avgWin = wins.length > 0 ? sumWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? sumLosses / losses.length : 0;
    const profitFactor = sumLosses !== 0 ? sumWins / Math.abs(sumLosses) : Infinity;

    // Duración de las posiciones
    const holds = closed
      .map((p) => {
        const last = p.trades && p.trades.length > 0 ? p.trades[p.trades.length - 1].timestamp : 0;
        return last > p.entryTimestamp ? (last - p.entryTimestamp) / 60_000 : null;
      })
      .filter((h): h is number => h !== null)
      .sort((a, b) => a - b);
    const medianHold = holds.length > 0 ? holds[Math.floor(holds.length / 2)] : 0;

    const best = closed.reduce((a, b) =>
      (a.realizedPnlSol ?? 0) >= (b.realizedPnlSol ?? 0) ? a : b,
    );
    const worst = closed.reduce((a, b) =>
      (a.realizedPnlSol ?? 0) <= (b.realizedPnlSol ?? 0) ? a : b,
    );

    console.log(`\n  Trades cerrados:  ${closed.length}`);
    console.log(`  Win rate:         ${pct(wins.length / closed.length)}  (${wins.length}W / ${losses.length}L)`);
    console.log(`  PnL total:        ${sol(totalPnl)}`);
    console.log(`  Ganancia media:   ${sol(avgWin)}   Pérdida media: ${sol(avgLoss)}`);
    console.log(`  Profit factor:    ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}  (>1 = rentable)`);
    console.log(`  Hold mediano:     ${medianHold.toFixed(1)} min`);
    console.log(`  Mejor:            ${best.symbol || best.mint.slice(0, 8)} ${sol(best.realizedPnlSol ?? 0)}`);
    console.log(`  Peor:             ${worst.symbol || worst.mint.slice(0, 8)} ${sol(worst.realizedPnlSol ?? 0)}`);

    // ---------- Por estrategia (sniper vs copy) ----------
    const byStrategy = new Map<string, Bucket>();
    for (const p of closed) {
      bucketAdd(byStrategy, p.strategy ?? 'sniper', p.realizedPnlSol ?? 0);
    }
    printBuckets('PnL por estrategia', byStrategy);

    // ---------- Por wallet copiada ----------
    const byWallet = new Map<string, Bucket>();
    for (const p of closed) {
      if (!p.copiedFrom) continue;
      const short = `${p.copiedFrom.slice(0, 4)}…${p.copiedFrom.slice(-4)}`;
      bucketAdd(byWallet, short, p.realizedPnlSol ?? 0);
    }
    printBuckets('PnL por wallet copiada', byWallet);

    // ---------- Por razón de salida ----------
    const byExit = new Map<string, Bucket>();
    for (const p of closed) {
      bucketAdd(byExit, p.exitEvent ?? 'DESCONOCIDO', p.realizedPnlSol ?? 0);
    }
    printBuckets('PnL por razón de salida', byExit);

    // ---------- Por compradores únicos en la observación ----------
    const byBuyers = new Map<string, Bucket>();
    for (const p of closed) {
      const ub = p.entryContext?.uniqueBuyers;
      if (ub === undefined) continue;
      const key = ub <= 5 ? '4-5 compradores' : ub <= 8 ? '6-8 compradores' : '9+ compradores';
      bucketAdd(byBuyers, key, p.realizedPnlSol ?? 0);
    }
    printBuckets('PnL por compradores únicos (ventana)', byBuyers);

    // ---------- Por mcap de entrada ----------
    const byMcap = new Map<string, Bucket>();
    for (const p of closed) {
      const m = p.entryContext?.entryMcapSol;
      if (m === undefined) continue;
      const key = m < 32 ? 'mcap < 32 SOL' : m < 45 ? 'mcap 32-45 SOL' : 'mcap 45+ SOL';
      bucketAdd(byMcap, key, p.realizedPnlSol ?? 0);
    }
    printBuckets('PnL por mcap de entrada', byMcap);

    // ---------- Por hora UTC ----------
    const byHour = new Map<string, Bucket>();
    for (const p of closed) {
      const h = p.entryContext?.hourUtc;
      if (h === undefined) continue;
      bucketAdd(byHour, `${String(h).padStart(2, '0')}:00 UTC`, p.realizedPnlSol ?? 0);
    }
    if (byHour.size > 0) {
      // orden cronológico para ver el patrón del día
      const sorted = new Map([...byHour.entries()].sort((a, b) => a[0].localeCompare(b[0])));
      printBuckets('PnL por hora de entrada (UTC)', sorted, false);
    }
  }

  // ---------- Rechazos ----------
  const rejections = readJsonl<Rejection>('rejections.jsonl');
  if (rejections.length > 0) {
    const byCat = new Map<string, number>();
    for (const r of rejections) {
      const cat = rejectionCategory(r.reason ?? '');
      byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
    }
    console.log(`\n── Rechazos de entrada (${rejections.length} total) ────────────────────`);
    for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
      const share = pct(n / rejections.length);
      console.log(`  ${cat.padEnd(36)} ${String(n).padStart(5)}  (${share})`);
    }
    console.log(
      '\n  💡 Si una categoría domina y sospechas que descarta ganadores,\n' +
      '     relaja ese parámetro en el .env y compara este reporte en unos días.',
    );
  }

  console.log('\n════════════════════════════════════════════════════════════\n');
}

main();
