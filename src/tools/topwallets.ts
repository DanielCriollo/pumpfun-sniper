import fs from 'fs';
import nodePath from 'path';

// -----------------------------------------------------------
// Minero de wallets candidatas para copy-trading
// -----------------------------------------------------------
// Analiza el firehose grabado (data/firehose/*.jsonl) y busca
// wallets que compran TEMPRANO en tokens que DESPUÉS subieron,
// pero DESCARTA automáticamente los bots de alta frecuencia:
// un bot que compra y revende en segundos/pocos minutos tiene
// "buen historial" en el sentido de que acertó el token, pero
// es IMPOSIBLE de copiar — para cuando tu bot reacciona a la
// señal de compra, el bot original ya vendió.
//
// Señales de bot que este script filtra:
//   1. Hold time mediano < MIN_HOLD_SECONDS entre su compra y su
//      primera venta del mismo mint.
//   2. Montos de compra casi idénticos repetidos (sizing
//      automatizado — ningún humano compra 0.303 SOL una y otra vez).
//
// Las que sobreviven ambos filtros SIGUEN necesitando validación
// manual en Solscan, pero al menos ya no son bots evidentes.
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
  /** wallet → { ts de su primera compra, SOL de esa compra } */
  buys: Map<string, { ts: number; sol: number }>;
  /** wallet → ts de su primera venta observada tras comprar */
  sells: Map<string, number>;
}

interface WalletStats {
  tokens: Set<string>;
  pumpedHits: string[];
  sumBuySol: number;
  buys: number;
  holdTimesSec: number[];
  buyAmounts: number[];
}

/** Un token "pumpeó" si su mcap máximo registrado superó al inicial en este factor */
const PUMP_FACTOR = 1.5;
/** Mínimo de tokens distintos para que una wallet sea candidata */
const MIN_TOKENS = 5;
/** Hold mediano mínimo para considerar la wallet copiable (bots venden antes) */
const MIN_HOLD_SECONDS = 120;
/** Mínimo de pares compra→venta observados para calcular el hold mediano con confianza */
const MIN_HOLD_SAMPLES = 3;
const TOP_N = 20;

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Fracción de compras que comparten el monto más repetido (redondeado a 3 decimales) */
function dominantAmountRatio(amounts: number[]): number {
  if (amounts.length < MIN_HOLD_SAMPLES) return 0;
  const counts = new Map<string, number>();
  for (const a of amounts) {
    const key = a.toFixed(3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(...counts.values());
  return maxCount / amounts.length;
}

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
        m = { firstMcap: d.marketCapSol, maxMcap: d.marketCapSol, buys: new Map(), sells: new Map() };
        mints.set(d.mint, m);
      }
      if (d.marketCapSol > m.maxMcap) m.maxMcap = d.marketCapSol;

      if (d.txType === 'buy' && !m.buys.has(d.traderPublicKey)) {
        m.buys.set(d.traderPublicKey, { ts: parsed.t, sol: d.solAmount ?? 0 });
      } else if (d.txType === 'sell' && !m.sells.has(d.traderPublicKey)) {
        // Solo cuenta como "su" venta si ya la habíamos visto comprar este mint
        if (m.buys.has(d.traderPublicKey)) {
          m.sells.set(d.traderPublicKey, parsed.t);
        }
      }
    }
  }

  // Agregar por wallet
  const wallets = new Map<string, WalletStats>();
  for (const [mint, m] of mints) {
    const pumped = m.firstMcap > 0 && m.maxMcap >= m.firstMcap * PUMP_FACTOR;
    for (const [wallet, buy] of m.buys) {
      let w = wallets.get(wallet);
      if (!w) {
        w = { tokens: new Set(), pumpedHits: [], sumBuySol: 0, buys: 0, holdTimesSec: [], buyAmounts: [] };
        wallets.set(wallet, w);
      }
      w.tokens.add(mint);
      w.buys++;
      w.sumBuySol += buy.sol;
      w.buyAmounts.push(buy.sol);
      if (pumped) w.pumpedHits.push(mint);

      const sellTs = m.sells.get(wallet);
      if (sellTs !== undefined && sellTs > buy.ts) {
        w.holdTimesSec.push((sellTs - buy.ts) / 1000);
      }
    }
  }

  // Candidatas: actividad mínima + NO son bots evidentes
  const allScored = Array.from(wallets.entries())
    .filter(([, w]) => w.tokens.size >= MIN_TOKENS)
    .map(([key, w]) => {
      const hitRate = w.pumpedHits.length / w.tokens.size;
      const holdMedianSec = median(w.holdTimesSec);
      const sameAmountRatio = dominantAmountRatio(w.buyAmounts);
      const hasHoldSample = w.holdTimesSec.length >= MIN_HOLD_SAMPLES;
      const looksLikeBot =
        (hasHoldSample && holdMedianSec < MIN_HOLD_SECONDS) || sameAmountRatio >= 0.4;
      return {
        key,
        tokens: w.tokens.size,
        hits: w.pumpedHits.length,
        hitRate,
        avgBuySol: w.sumBuySol / Math.max(1, w.buys),
        holdMedianSec,
        hasHoldSample,
        sameAmountRatio,
        looksLikeBot,
        score: w.pumpedHits.length * hitRate,
      };
    })
    .sort((a, b) => b.score - a.score);

  const candidates = allScored.filter((c) => !c.looksLikeBot).slice(0, TOP_N);
  const botsFiltered = allScored.filter((c) => c.looksLikeBot).length;

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('  WALLETS CANDIDATAS PARA COPY-TRADING (minadas de tu firehose)');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(`  Tokens analizados: ${mints.size}   Trades: ${tradeLines}   Wallets vistas: ${wallets.size}`);
  console.log(
    `  Con actividad mínima (>=${MIN_TOKENS} tokens): ${allScored.length}   Descartadas por parecer bot: ${botsFiltered}\n`,
  );

  if (candidates.length === 0) {
    console.log('  Ninguna wallet sobrevivió el filtro anti-bot todavía.');
    console.log('  Deja el bot corriendo más tiempo para acumular más firehose y vuelve a intentar.\n');
    return;
  }

  console.log('  wallet                                        tokens  aciertos  tasa   buy prom.  hold mediano');
  console.log('  ' + '─'.repeat(100));
  for (const c of candidates) {
    const holdLabel = c.hasHoldSample
      ? `${(c.holdMedianSec / 60).toFixed(1)} min`
      : 'sin datos';
    console.log(
      `  ${c.key.padEnd(44)} ${String(c.tokens).padStart(6)}  ${String(c.hits).padStart(8)}  ${(c.hitRate * 100).toFixed(0).padStart(3)}%  ${c.avgBuySol.toFixed(3)} SOL   ${holdLabel}`,
    );
  }

  console.log(`
  Filtro anti-bot aplicado: se descartaron wallets con hold mediano
  < ${MIN_HOLD_SECONDS / 60} min entre compra y venta, o con >=40% de sus compras
  en el mismo monto exacto (sizing automatizado). "sin datos" = aún
  no vimos a esa wallet vender ninguno de sus tokens — puede ser un
  holder legítimo o simplemente no le tocó salir todavía; revisa su
  hold real en Solscan antes de confiar en ella.

  ⚠️  ANTES de agregar cualquiera a COPY_WALLETS, valídala en solscan.io:
     1. Confirma holds de MINUTOS reales en su historial completo
     2. Que NO compre en el mismo bloque del create (eso es un bundler)
     3. Ganancias consistentes en el tiempo, no un solo pelotazo
     4. Excluye tu propia wallet si aparece en la lista

  Para seguirlas: COPY_WALLETS=wallet1,wallet2,... en el .env y reinicia.
`);
}

main();
