import { PublicKey } from '@solana/web3.js';
import { connection } from '../services/solana';
import { logger } from '../logger';

// -----------------------------------------------------------
// Validador ON-CHAIN de wallets — hold-time real desde Solana
// -----------------------------------------------------------
// A diferencia de topwallets.ts (que depende del firehose, y solo
// ve la venta de una wallet si ocurre dentro de la ventana de
// observación de 8s de un mint que además decidimos vigilar),
// este script consulta DIRECTAMENTE el historial on-chain completo
// de cada wallet vía RPC. Elimina el problema de "sin datos" y
// habría detectado el caso de Hh2yn37j... (parecía trader de
// minutos en una muestra chica de Solscan, resultó scalpear en
// 5-10 segundos en la práctica) ANTES de arriesgar dinero real.
//
// Uso: node dist/tools/validatewallets.js <wallet1> [wallet2] ...
// -----------------------------------------------------------

const MAX_SIGNATURES = 150;
const RPC_DELAY_MS = 250; // throttle — RPC gratuito se satura rápido
const MIN_HOLD_SECONDS_HUMAN = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface MintEvent {
  mint: string;
  ts: number;
  direction: 'buy' | 'sell';
  amount: number;
}

/** Reconstruye, a partir del historial on-chain, cada cambio de balance de tokens de la wallet */
async function fetchWalletEvents(wallet: string): Promise<MintEvent[]> {
  const pubkey = new PublicKey(wallet);
  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: MAX_SIGNATURES }, 'confirmed');
  const events: MintEvent[] = [];

  for (const sigInfo of sigs) {
    if (sigInfo.err) continue;
    try {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      await sleep(RPC_DELAY_MS);
      if (!tx?.meta || !tx.blockTime) continue;

      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      const mints = new Set<string>([...pre.map((b) => b.mint), ...post.map((b) => b.mint)]);

      for (const mint of mints) {
        const preBal = pre.find((b) => b.mint === mint && b.owner === wallet);
        const postBal = post.find((b) => b.mint === mint && b.owner === wallet);
        const preAmt = preBal?.uiTokenAmount.uiAmount ?? 0;
        const postAmt = postBal?.uiTokenAmount.uiAmount ?? 0;
        const delta = postAmt - preAmt;
        if (Math.abs(delta) < 1e-9) continue;
        events.push({
          mint,
          ts: tx.blockTime * 1000,
          direction: delta > 0 ? 'buy' : 'sell',
          amount: Math.abs(delta),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug({ wallet, sig: sigInfo.signature, err: msg }, 'Fallo leyendo tx — se ignora');
    }
  }

  return events.sort((a, b) => a.ts - b.ts);
}

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function validateWallet(wallet: string): Promise<void> {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${wallet}`);
  console.log('═'.repeat(72));

  const events = await fetchWalletEvents(wallet);
  if (events.length === 0) {
    console.log('  Sin actividad de tokens detectada en las transacciones recientes.');
    return;
  }

  // Agrupar por mint para emparejar primera compra → primera venta posterior
  const byMint = new Map<string, MintEvent[]>();
  for (const e of events) {
    const arr = byMint.get(e.mint) ?? [];
    arr.push(e);
    byMint.set(e.mint, arr);
  }

  const holdTimesSec: number[] = [];
  let mintsWithBuy = 0;
  let mintsWithBuyAndSell = 0;

  for (const [, evs] of byMint) {
    const firstBuy = evs.find((e) => e.direction === 'buy');
    if (!firstBuy) continue;
    mintsWithBuy++;
    const sellAfter = evs.find((e) => e.direction === 'sell' && e.ts > firstBuy.ts);
    if (sellAfter) {
      mintsWithBuyAndSell++;
      holdTimesSec.push((sellAfter.ts - firstBuy.ts) / 1000);
    }
  }

  const holdMedian = median(holdTimesSec);
  const fastCount = holdTimesSec.filter((h) => h < MIN_HOLD_SECONDS_HUMAN).length;
  const fastRatio = holdTimesSec.length > 0 ? fastCount / holdTimesSec.length : 0;

  console.log(`  Transacciones analizadas: ${events.length}`);
  console.log(`  Mints con compra: ${mintsWithBuy}   Con compra+venta observada: ${mintsWithBuyAndSell}`);
  if (holdTimesSec.length > 0) {
    console.log(`  Hold mediano REAL (on-chain):  ${(holdMedian / 60).toFixed(2)} min`);
    console.log(
      `  % de holds < 2 min:            ${(fastRatio * 100).toFixed(0)}%  (${fastCount}/${holdTimesSec.length})`,
    );
    const sample = holdTimesSec.slice(0, 20).map((h) => (h / 60).toFixed(1));
    console.log(`  Muestra de holds (min):        ${sample.join(', ')}${holdTimesSec.length > 20 ? '…' : ''}`);
  } else {
    console.log('  No se observaron pares compra→venta completos en el historial reciente.');
  }

  const verdict =
    holdTimesSec.length < 3
      ? '⚠️  Muestra insuficiente — revisar manualmente en Solscan'
      : fastRatio >= 0.5
        ? '🤖 BOT probable — mayoría de holds < 2 min. NO copiar.'
        : fastRatio >= 0.25
          ? '⚠️  MIXTO — algunos holds muy rápidos. Copiar con cautela y sizing chico.'
          : '✅ Perfil humano — holds mayormente > 2 min.';
  console.log(`\n  Veredicto: ${verdict}`);
}

async function main(): Promise<void> {
  const wallets = process.argv.slice(2).map((w) => w.trim()).filter(Boolean);
  if (wallets.length === 0) {
    console.log('Uso: node dist/tools/validatewallets.js <wallet1> [wallet2] ...');
    console.log('Consulta el historial on-chain REAL de cada wallet (no depende del firehose)');
    console.log('para medir su hold-time real y detectar bots ANTES de agregarla a COPY_WALLETS.');
    return;
  }

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('  VALIDADOR ON-CHAIN DE WALLETS — hold-time real desde Solana');
  console.log(`  Analizando ${wallets.length} wallet(s), hasta ${MAX_SIGNATURES} tx cada una…`);
  console.log('  (puede tardar varios minutos por el throttling del RPC)');
  console.log('════════════════════════════════════════════════════════════════════');

  for (const wallet of wallets) {
    try {
      await validateWallet(wallet);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n  ❌ Error validando ${wallet}: ${msg}`);
    }
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  Listo. Sigue siendo una señal automatizada — para veredictos ✅ o');
  console.log('  ⚠️ MIXTO, revisa a mano un par de trades recientes en Solscan antes');
  console.log('  de arriesgar dinero real en esa wallet.');
  console.log('═'.repeat(72) + '\n');
}

main();
