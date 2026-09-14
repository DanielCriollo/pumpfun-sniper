import fs from 'fs';
import nodePath from 'path';

// -----------------------------------------------------------
// Minero de wallets candidatas para copy-trading
// -----------------------------------------------------------
// Analiza el firehose grabado (data/firehose/*.jsonl) y busca
// wallets que compran TEMPRANO (dentro de nuestras ventanas de
// observación) en tokens que DESPUÉS subieron. Esas wallets son
// candidatas a COPY_WALLETS — pero SIEMPRE valídalas a mano en
// Solscan antes de seguirlas:
//   - ¿Holds de minutos (copiable) o de segundos (imposible)?
//   - ¿Compra post-lanzamiento o en el bloque 0 (bundler)?
//   - ¿Gana consistentemente o tuvo un pelotazo?
//
// Standalone: no necesita .env. Ejecutar tras `npm run build`:
//   node dist/tools/topwallets.js
// -----------------------------------------------------------

interface TradeData {
  mint?: string;
  traderPublicKey?: string;
  txType?: string;
  solAmount?: number;
  marketCapSol?: number;
}

interface FireLine {
  t: number;
  type: string;
  data: TradeData;
}

interface MintStats {
  firstMcap: number;
  maxMcap: number;
  buyers: Map<string, number>; // wallet → SOL de su primera compra registrada
}

interface WalletStats {
  tokens: Set<string>;
  pumpedHits: string[];
  sumBuySol: number;
  buys: number;
}

/** Un token "pumpeó" si su mcap máximo registrado superó al inicial en este factor */
const PUMP_FACTOR = 1.5;
/** Mínimo de tokens distintos para que una wallet sea candidata */
const MIN_TOKENS = 5;
const TOP_N = 20;

function main(): void {
  const dir = nodePath.join(process.cwd(), 'data', 'firehose');
  if (!fs.existsSync(dir)) {
    console.log('No existe data/firehose/ — activa RECORD_FIREHOSE y deja correr el bot.');
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  if (files.length === 0) {
    console.log('data/firehose/ está vacío — deja correr el bot para acumular datos.');
    return;
  }

  const mints = new Map<string, MintStats>();
  let tradeLines = 0;

  for (const file of files) {
    const raw = fs.readFileSync(nodePath.join(dir, file), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: FireLine;
      try {
        parsed = JSON.parse(trimmed) as FireLine;
      } catch {
        continue;
      }
      if (parsed.type !== 'trade') continue;
      const d = parsed.data;
      if (!d?.mint || !d.traderPublicKey || typeof d.marketCapSol !== 'number') continue;
      tradeLines++;

      let m = mints.get(d.mint);
      if (!m) {
        m = { firstMcap: d.marketCapSol, maxMcap: d.marketCapSol, buyers: new Map() };
        mints.set(d.mint, m);
      }
      if (d.marketCapSol > m.maxMcap) m.maxMcap = d.marketCapSol;
      if (d.txType === 'buy' && !m.buyers.has(d.traderPublicKey)) {
        m.buyers.set(d.traderPublicKey, d.solAmount ?? 0);
      }
    }
  }

  // Agregar por wallet
  const wallets = new Map<string, WalletStats>();
  for (const [mint, m] of mints) {
    const pumped = m.firstMcap > 0 && m.maxMcap >= m.firstMcap * PUMP_FACTOR;
    for (const [wallet, buySol] of m.buyers) {
      let w = wallets.get(wallet);
      if (!w) {
        w = { tokens: new Set(), pumpedHits: [], sumBuySol: 0, buys: 0 };
        wallets.set(wallet, w);
      }
      w.tokens.add(mint);
      w.buys++;
      w.sumBuySol += buySol;
      if (pumped) w.pumpedHits.push(mint);
    }
  }

  // Candidatas: actividad mínima, ordenadas por aciertos ponderados por tasa
  const candidates = Array.from(wallets.entries())
    .filter(([, w]) => w.tokens.size >= MIN_TOKENS)
    .map(([key, w]) => {
      const hitRate = w.pumpedHits.length / w.tokens.size;
      return {
        key,
        tokens: w.tokens.size,
        hits: w.pumpedHits.length,
        hitRate,
        avgBuySol: w.sumBuySol / Math.max(1, w.buys),
        score: w.pumpedHits.length * hitRate,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('  WALLETS CANDIDATAS PARA COPY-TRADING (minadas de tu firehose)');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(`  Tokens analizados: ${mints.size}   Trades: ${tradeLines}   Wallets vistas: ${wallets.size}\n`);

  if (candidates.length === 0) {
    console.log('  Aún no hay wallets con actividad suficiente (mín. 5 tokens).');
    console.log('  Deja el bot corriendo más tiempo para acumular firehose.\n');
    return;
  }

  console.log('  wallet                                        tokens  aciertos  tasa   buy prom.');
  console.log('  ' + '─'.repeat(84));
  for (const c of candidates) {
    console.log(
      `  ${c.key.padEnd(44)} ${String(c.tokens).padStart(6)}  ${String(c.hits).padStart(8)}  ${(c.hitRate * 100).toFixed(0).padStart(3)}%  ${c.avgBuySol.toFixed(3)} SOL`,
    );
  }

  console.log(`
  ⚠️  ANTES de agregar cualquiera a COPY_WALLETS, valídala en solscan.io:
     1. Holds de MINUTOS (no de segundos — esos no se pueden copiar)
     2. Que NO compre en el mismo bloque del create (eso es un bundler)
     3. Ganancias consistentes en el tiempo, no un solo pelotazo
     4. Excluye tu propia wallet si aparece en la lista

  Para seguirlas: COPY_WALLETS=wallet1,wallet2,... en el .env y reinicia.
`);
}

main();
