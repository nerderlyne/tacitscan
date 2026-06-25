// Cursor-driven block walker. Pattern is intentionally close to Ponder:
//   - tracks last_indexed_height per network
//   - polls a Bitcoin data source for new blocks
//   - per block: decode envelopes from vin[0].witness, run handlers
//   - re-runs cleanly on restart (handlers are idempotent via PKs)
//
// Reorg handling:
//   On detecting a parent-hash mismatch, walk back through our `blocks`
//   table comparing each height's recorded hash to the canonical chain
//   hash (getBlockHashByHeight). The first match is the common ancestor;
//   everything above gets `chain_status='orphaned'` and re-processes from
//   ancestor+1. We DON'T delete envelopes — keeping them as 'orphaned'
//   lets the UI show "this tx was reorged out" for users following links.
//   Re-inclusion (same tx in a new block) cleanly upserts back to
//   'confirmed' via handlers.ts envelopeConfirmSet.
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "./db.js";
import { hexToBytes, tryDecodeFromWitness, type DecodeResult } from "./envelope.js";
import { EsploraClient, type EsploraTx } from "./esplora.js";
import { BitcoinRpcClient } from "./rpc.js";
import { withFallback, type BitcoinDataSource } from "./source.js";
import { persistEnvelope, type TxCtx } from "./handlers.js";

interface Config {
  network: string;
  rpcUrl?: string;
  esploraUrl: string;
  esploraFallback?: string;
  // Maestro (gomaestro.org) is Esplora-compatible at the URL level but
  // requires an `api-key` header. When MAESTRO_API_KEY is set we slot
  // it between dRPC and mempool.space in the fallback chain — gives us
  // 10 req/s headroom for the tx-fetch heavy paths (mempool poller,
  // address harvester) without burning the free mempool.space allowance.
  maestroUrl: string;
  maestroApiKey?: string;
  startHeight: number;
  confirmationDepth: number;
  tipPollSec: number;
  backfillBatch: number;
  maxReorgDepth: number;
}

export function loadConfig(): Config {
  const network = process.env.BITCOIN_NETWORK ?? "mainnet";
  const rpcUrl = process.env.BITCOIN_RPC_URL || undefined;
  const esploraUrl = process.env.ESPLORA_URL ?? "https://mempool.space/api";
  const esploraFallback = process.env.ESPLORA_FALLBACK_URL || undefined;
  const maestroUrl = process.env.MAESTRO_URL ?? "https://xbt-mainnet.gomaestro-api.org/v0";
  const maestroApiKey = process.env.MAESTRO_API_KEY || undefined;
  const startHeight = Number(process.env.START_HEIGHT ?? 860000);
  // Default 1: indexer stays exactly one block behind tip. Reorgs are
  // rare on Bitcoin (≥2 ~once/year, ≥3 effectively never since 2013)
  // and the walk-back code handles them — paying 3-block lag for an
  // event that happens once a year isn't worth it for an explorer.
  const confirmationDepth = Number(process.env.CONFIRMATION_DEPTH ?? 1);
  const tipPollSec = Number(process.env.TIP_POLL_INTERVAL ?? 30);
  const backfillBatch = Number(process.env.BACKFILL_BATCH_SIZE ?? 10);
  // Walk-back hard cap. Deeper than this and we bail rather than silently
  // re-process huge ranges; Bitcoin hasn't seen a >5-block reorg since
  // 2013, so 20 is comfortably generous.
  const maxReorgDepth = Number(process.env.MAX_REORG_DEPTH ?? 20);
  return {
    network,
    rpcUrl,
    esploraUrl,
    esploraFallback,
    maestroUrl,
    maestroApiKey,
    startHeight,
    confirmationDepth,
    tipPollSec,
    backfillBatch,
    maxReorgDepth,
  };
}

function buildSource(cfg: Config): BitcoinDataSource {
  // Fallback chain, ordered by per-call efficiency / rate budget:
  //   1. dRPC (or any Bitcoin JSON-RPC) — `getblock v2` returns header
  //      + every tx with witness in one HTTP call, by far the cheapest
  //      way to walk blocks.
  //   2. Maestro (gomaestro.org) — Esplora-compatible REST with an
  //      api-key header. ~10 req/s on Starter tier; ideal for the
  //      per-tx fetches the mempool poller and address harvester make.
  //   3. mempool.space (or any public Esplora) — free, rate-limited;
  //      last-line fallback when the paid options are down.
  // Earlier entries win; withFallback chains them so each falls back
  // to the next on throw.
  const fallbacks: BitcoinDataSource[] = [];
  if (cfg.rpcUrl) fallbacks.push(new BitcoinRpcClient(cfg.rpcUrl));
  if (cfg.maestroApiKey) {
    fallbacks.push(
      new EsploraClient(
        cfg.maestroUrl,
        undefined,
        { "api-key": cfg.maestroApiKey },
        "maestro",
      ),
    );
  }
  fallbacks.push(new EsploraClient(cfg.esploraUrl, cfg.esploraFallback));
  // Reduce right-to-left so primary stays first and each falls back
  // through the rest in declared order.
  return fallbacks.reduceRight((next, current) => (next ? withFallback(current, next) : current));
}

async function getOrInitCursor(network: string, startHeight: number): Promise<{ height: number; hash: string }> {
  const existing = await db.query.cursor.findFirst({ where: eq(schema.cursor.network, network) });
  if (existing) return { height: existing.lastIndexedHeight, hash: existing.lastIndexedBlockHash };
  await db.insert(schema.cursor).values({
    network,
    lastIndexedHeight: startHeight - 1,
    lastIndexedBlockHash: "",
  });
  return { height: startHeight - 1, hash: "" };
}

async function setCursor(network: string, height: number, hash: string): Promise<void> {
  await db
    .update(schema.cursor)
    .set({ lastIndexedHeight: height, lastIndexedBlockHash: hash, updatedAt: new Date() })
    .where(eq(schema.cursor.network, network));
}

// Walk back through our `blocks` table comparing each recorded hash to
// canonical chain hash. Returns the highest height where they match (=
// common ancestor). If we walk past `maxReorgDepth` without finding a
// match, throws — better to fail loudly than to silently rewrite far
// history.
async function findCommonAncestor(
  source: BitcoinDataSource,
  network: string,
  fromHeight: number,
  maxDepth: number,
): Promise<number> {
  for (let h = fromHeight; h >= fromHeight - maxDepth; h--) {
    const row = await db.query.blocks.findFirst({
      where: and(eq(schema.blocks.network, network), eq(schema.blocks.height, h)),
    });
    if (!row) continue;
    const canonical = await source.getBlockHashByHeight(h);
    if (canonical === row.blockHash) return h;
  }
  throw new Error(
    `reorg deeper than MAX_REORG_DEPTH=${maxDepth} at heights ${fromHeight - maxDepth}..${fromHeight} — investigate before continuing`,
  );
}

// Mark every envelope above `ancestorHeight` as orphaned and drop the
// blocks-table rows so the next walk treats those heights as fresh.
// Envelope rows are kept so the UI can still surface their pages — the
// chain_status flips back to 'confirmed' if/when the same tx is re-included.
async function rewindTo(network: string, ancestorHeight: number): Promise<void> {
  await db.transaction(async (t) => {
    await t
      .update(schema.envelopes)
      .set({ chainStatus: "orphaned" })
      .where(and(eq(schema.envelopes.network, network), gt(schema.envelopes.blockHeight, ancestorHeight)));
    await t
      .delete(schema.blocks)
      .where(and(eq(schema.blocks.network, network), gt(schema.blocks.height, ancestorHeight)));
  });
}

async function recordBlock(network: string, height: number, hash: string, blockTime: Date): Promise<void> {
  await db
    .insert(schema.blocks)
    .values({ network, height, blockHash: hash, blockTime })
    .onConflictDoUpdate({
      target: [schema.blocks.network, schema.blocks.height],
      set: { blockHash: hash, blockTime, processedAt: new Date() },
    });
}

// Harvest P2TR addresses from a confirmed tacit tx and persist them
// into tx_addresses. dRPC's getblock v2 doesn't include prevout
// addresses, so we always re-fetch the tx via the data source's fetchTx
// which is Esplora-backed via the fallback. ~1 extra HTTP call per
// tacit tx; tacit txs are <1/block on average so cost is negligible.
//
// Index ONLY v1_p2tr (bech32m P2TR) outputs since that's the only form
// the address page accepts.
async function indexTxAddresses(
  source: BitcoinDataSource,
  network: string,
  tx: EsploraTx,
): Promise<void> {
  // tx as received from the block walker has vin.prevout=null when the
  // source is RPC. Re-fetch via Esplora (or whatever fetchTx the fallback
  // resolves to) to get prevout addresses.
  let resolved = tx;
  const needsPrevouts = tx.vin.some((v) => !v.is_coinbase && !v.prevout);
  if (needsPrevouts) {
    try {
      resolved = await source.fetchTx(tx.txid);
    } catch (e) {
      console.warn(`[addresses] fetchTx(${tx.txid}) failed, skipping address index: ${(e as Error).message}`);
      return;
    }
  }

  // Dedupe (address, role) pairs across the tx so re-using the same
  // change address as both input and output records two rows (the user
  // wants both perspectives).
  const seen = new Set<string>();
  const rows: { network: string; txid: string; address: string; role: "input" | "output" }[] = [];
  for (const o of resolved.vout) {
    if (o.scriptpubkey_type !== "v1_p2tr" || !o.scriptpubkey_address) continue;
    const key = `o:${o.scriptpubkey_address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ network, txid: resolved.txid, address: o.scriptpubkey_address, role: "output" });
  }
  for (const v of resolved.vin) {
    const po = v.prevout;
    if (!po || po.scriptpubkey_type !== "v1_p2tr" || !po.scriptpubkey_address) continue;
    const key = `i:${po.scriptpubkey_address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ network, txid: resolved.txid, address: po.scriptpubkey_address, role: "input" });
  }
  if (rows.length === 0) return;
  await db.insert(schema.txAddresses).values(rows).onConflictDoNothing();
}

async function processBlock(
  source: BitcoinDataSource,
  network: string,
  height: number,
  expectedPrevHash: string,
): Promise<{ blockHash: string; processed: number; reorg: boolean }> {
  const block = await source.fetchBlock(height);

  // Reorg check: parent of this block must be our last indexed block.
  if (expectedPrevHash && block.previousblockhash !== expectedPrevHash) {
    console.warn(
      `[${network}] reorg detected at height ${height}: parent=${block.previousblockhash} expected=${expectedPrevHash}`,
    );
    return { blockHash: block.hash, processed: 0, reorg: true };
  }

  const blockTime = new Date(block.timestamp * 1000);
  let processed = 0;
  for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
    const tx = block.txs[txIndex]!;
    const envelopeResult = decodeTacit(tx);
    if (!envelopeResult) continue;
    const { result, rawWitness } = envelopeResult;
    const ctx: TxCtx = {
      network,
      height,
      blockHash: block.hash,
      blockTime,
      txid: tx.txid,
      txIndex,
      inputCount: tx.vin.length,
      outputCount: tx.vout.length,
      feeSats: tx.fee == null ? null : BigInt(tx.fee),
    };
    try {
      await persistEnvelope(db, tx, ctx, result, rawWitness);
      // Fire-and-forget address index — failure here doesn't block the
      // envelope from landing. tx_addresses is purely for the /address
      // page's interaction log; a missing row degrades that page but
      // doesn't affect protocol correctness.
      indexTxAddresses(source, network, tx).catch((e) =>
        console.warn(`[addresses] tx=${tx.txid}: ${(e as Error).message}`),
      );
      processed++;
    } catch (e) {
      console.error(`[${network}] failed to persist envelope tx=${tx.txid}:`, e);
    }
  }
  await recordBlock(network, height, block.hash, blockTime);
  return { blockHash: block.hash, processed, reorg: false };
}

function decodeTacit(tx: EsploraTx): { result: DecodeResult; rawWitness: Uint8Array } | null {
  const w = tx.vin[0]?.witness;
  if (!w || w.length < 2) return null;
  let raw: Uint8Array;
  try {
    raw = hexToBytes(w[1]!);
  } catch {
    return null;
  }
  if (!containsMagic(raw)) return null;
  const result = tryDecodeFromWitness(w);
  if (!result) return null;
  return { result, rawWitness: raw };
}

const MAGIC_BYTES = [0x54, 0x41, 0x43, 0x49, 0x54];
function containsMagic(buf: Uint8Array): boolean {
  outer: for (let i = 0; i + MAGIC_BYTES.length <= buf.length; i++) {
    for (let j = 0; j < MAGIC_BYTES.length; j++) {
      if (buf[i + j] !== MAGIC_BYTES[j]) continue outer;
    }
    return true;
  }
  return false;
}

export async function runIndexer(): Promise<never> {
  const cfg = loadConfig();
  const source = buildSource(cfg);
  let cursor = await getOrInitCursor(cfg.network, cfg.startHeight);
  console.log(
    `[${cfg.network}] starting at height ${cursor.height + 1}, source=${source.name}, confirmationDepth=${cfg.confirmationDepth}`,
  );

  // The block walker must never take the process down. Every external dep
  // it touches (data sources, DB) can throw transiently — a paid RPC that
  // runs out of balance, an all-sources-down moment, a tip-adjacent 404.
  // On ANY throw we log, sleep, and retry the iteration. Progress is
  // checkpointed in the cursor after each block, so a retry resumes exactly
  // where it left off. Combined with the Esplora client's rate-limit
  // backoff, the worst case is "indexes slowly", never "crashes".
  while (true) {
    try {
      const tip = await source.getTipHeight();
      const safeTip = tip - cfg.confirmationDepth;
      if (cursor.height >= safeTip) {
        await sleep(cfg.tipPollSec * 1000);
        continue;
      }

      const next = cursor.height + 1;
      const batchEnd = Math.min(next + cfg.backfillBatch - 1, safeTip);
      const startedAt = Date.now();
      let totalProcessed = 0;

      for (let h = next; h <= batchEnd; h++) {
        const { blockHash, processed, reorg } = await processBlock(source, cfg.network, h, cursor.hash);
        if (reorg) {
          const ancestor = await findCommonAncestor(source, cfg.network, cursor.height, cfg.maxReorgDepth);
          console.warn(`[${cfg.network}] rewinding to ancestor height=${ancestor}`);
          await rewindTo(cfg.network, ancestor);
          const ancestorRow = await db.query.blocks.findFirst({
            where: and(eq(schema.blocks.network, cfg.network), eq(schema.blocks.height, ancestor)),
          });
          cursor = { height: ancestor, hash: ancestorRow?.blockHash ?? "" };
          await setCursor(cfg.network, cursor.height, cursor.hash);
          break;
        }
        totalProcessed += processed;
        cursor = { height: h, hash: blockHash };
        await setCursor(cfg.network, h, blockHash);
      }

      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (cursor.height >= next) {
        console.log(
          `[${cfg.network}] ${next}..${cursor.height} (+${totalProcessed} envelopes) in ${took}s, tip=${tip}`,
        );
      }
    } catch (e) {
      // Don't advance the cursor — retry from the same height next loop.
      console.error(
        `[${cfg.network}] walker iteration failed at height ${cursor.height + 1}, retrying after backoff: ${(e as Error).message}`,
      );
      await sleep(cfg.tipPollSec * 1000);
    }
  }
}

// Promote any envelope rows still flagged 'mempool' for txs that have
// landed in confirmed blocks the indexer has already processed. This
// handles the race where a tx is in mempool, the block walker passes its
// height, and the upsert runs — but it's also defensive against the
// mempool poller and block walker getting briefly out of order.
//
// Currently unused — the block walker's upsert handles promotion inline.
// Exported so a future "stuck-mempool" sweeper can call it.
export async function promoteStuckMempool(network: string): Promise<number> {
  const stuck = await db
    .select({ txid: schema.envelopes.txid })
    .from(schema.envelopes)
    .where(and(eq(schema.envelopes.network, network), eq(schema.envelopes.chainStatus, "mempool")));
  return stuck.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Re-export so other loops can use the shared block-walker helpers.
export { decodeTacit, containsMagic, indexTxAddresses, buildSource };
