import { PROTOCOL_REVISION, DECODER_VERSION } from './protocol.js';
import { persistObservations } from './observations.js';
import { clearParentCache } from './validator.js';
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
import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "./db.js";
import { hexToBytes, tryDecodeFromWitness, type DecodeResult } from "./envelope.js";
import { EsploraClient, type EsploraTx } from "./esplora.js";
import { BitcoinRpcClient } from "./rpc.js";
import { withFallback, type BitcoinDataSource } from "./source.js";
import { persistEnvelope, type TxCtx } from "./handlers.js";

// Free, keyless, unmetered public Bitcoin JSON-RPC nodes. The RPC client
// round-robins across them so the backfill isn't bottlenecked on one free
// node's rate limit and each covers for the other when throttled. Mainnet
// only — signet has no equivalent, so it stays on Esplora unless
// BITCOIN_RPC_URL is set explicitly.
const DEFAULT_MAINNET_RPC_URLS = [
  "https://bitcoin-rpc.publicnode.com",
  "https://bitcoin.drpc.org",
];

interface Config {
  network: string;
  // One or more Bitcoin JSON-RPC endpoints, tried round-robin. Defaults to
  // the free public nodes above on mainnet; override (single or comma-
  // separated) via BITCOIN_RPC_URL.
  rpcUrls: string[];
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
  if (!["mainnet","signet"].includes(network)) throw new Error("Unsupported BITCOIN_NETWORK");
  const rpcUrls = resolveRpcUrls(network);
  const esploraUrl = process.env.ESPLORA_URL ?? (network === "signet" ? "https://mempool.space/signet/api" : "https://mempool.space/api");
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
  for (const [name,value] of Object.entries({startHeight,confirmationDepth,tipPollSec,backfillBatch,maxReorgDepth})) {
    if(!Number.isSafeInteger(value) || value < (name==='startHeight'?0:1)) throw new Error(`Invalid indexer setting ${name}`);
  }
  return {
    network,
    rpcUrls,
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

function resolveRpcUrls(network: string): string[] {
  // Explicit override wins — comma-separated for multiple endpoints.
  const explicit = (process.env.BITCOIN_RPC_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  // No override: default mainnet to the free public nodes; leave signet
  // (and any other network) on Esplora unless BITCOIN_RPC_URL is set.
  return network === "mainnet" ? DEFAULT_MAINNET_RPC_URLS : [];
}

function buildSource(cfg: Config): BitcoinDataSource {
  // Fallback chain, ordered by per-call efficiency / rate budget:
  //   1. Bitcoin JSON-RPC — `getblock v2` returns header + every tx with
  //      witness in one HTTP call, by far the cheapest way to walk blocks.
  //      Round-robins across all configured endpoints (the free public
  //      nodes by default).
  //   2. Maestro (gomaestro.org) — Esplora-compatible REST with an
  //      api-key header. ~10 req/s on Starter tier; ideal for the
  //      per-tx fetches the mempool poller and address harvester make.
  //   3. mempool.space (or any public Esplora) — free, rate-limited;
  //      last-line fallback when the options above are down.
  // Earlier entries win; withFallback chains them so each falls back
  // to the next on throw.
  const fallbacks: BitcoinDataSource[] = [];
  if (cfg.rpcUrls.length) fallbacks.push(new BitcoinRpcClient(cfg.rpcUrls));
  if (cfg.maestroApiKey && (cfg.network === "mainnet" || process.env.MAESTRO_URL)) {
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
  clearParentCache();
  await db.transaction(async (t) => {
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${network}),81420)`);
    const ancestor = await t.select().from(schema.blocks).where(and(eq(schema.blocks.network,network),eq(schema.blocks.height,ancestorHeight))).limit(1);
    await t.update(schema.cursor).set({lastIndexedHeight:ancestorHeight,lastIndexedBlockHash:ancestor[0]?.blockHash??"",updatedAt:new Date()}).where(eq(schema.cursor.network,network));
    await t
      .update(schema.envelopes)
      .set({ chainStatus: "orphaned" })
      .where(and(eq(schema.envelopes.network, network), gt(schema.envelopes.blockHeight, ancestorHeight)));
    await t.delete(schema.commitments).where(and(eq(schema.commitments.network,network),gt(schema.commitments.blockHeight,ancestorHeight)));
    await t.delete(schema.assets).where(and(eq(schema.assets.network,network),gt(schema.assets.etchHeight,ancestorHeight)));
    await t.delete(schema.txAddresses).where(sql`${schema.txAddresses.network}=${network} AND ${schema.txAddresses.txid} IN (SELECT txid FROM envelopes WHERE network=${network} AND chain_status='orphaned')`);
    await t.execute(sql`UPDATE envelopes SET commitment_valid=NULL,commitment_checked_at=NULL,issuer_sig_valid=NULL,issuer_sig_checked_at=NULL WHERE network=${network} AND block_height>${ancestorHeight}`);
    // Reorg cleanup also runs while new observation ingestion is disabled.
    if((await t.execute(sql`SELECT to_regclass('protocol_scan_windows') AS name`))[0]?.name) {
      await t.execute(sql`UPDATE protocol_envelopes SET chain_status='orphaned',validation_status='unchecked',validation_evidence=NULL WHERE network=${network} AND block_height>${ancestorHeight}`);
      await t.execute(sql`DELETE FROM protocol_scan_windows WHERE source=${'bitcoin:'+network} AND last_height>${ancestorHeight}`);
      await t.execute(sql`DELETE FROM protocol_validation_jobs WHERE network=${network} AND block_height>${ancestorHeight}`);
      await t.execute(sql`DELETE FROM protocol_outputs WHERE network=${network} AND block_height>${ancestorHeight}`);
      await t.execute(sql`DELETE FROM protocol_spends WHERE network=${network} AND block_height>${ancestorHeight}`);
      await t.execute(sql`UPDATE protocol_cursors SET height=${ancestorHeight},block_hash=${ancestor[0]?.blockHash??''},updated_at=now() WHERE source=${'bitcoin:'+network}`);
    }
    await t
      .delete(schema.blocks)
      .where(and(eq(schema.blocks.network, network), gt(schema.blocks.height, ancestorHeight)));
  });
  clearParentCache();
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

export async function processBlock(
  source: BitcoinDataSource,
  network: string,
  height: number,
  expectedPrevHash: string,
  advanceCursor = true,
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
  const addresses: EsploraTx[] = [];
  await db.transaction(async (transaction) => {
  const writer = transaction as unknown as typeof db;
  await writer.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${network}),81420)`);
  if(advanceCursor) {
    const current=await writer.select().from(schema.cursor).where(eq(schema.cursor.network,network)).limit(1);
    if(!current[0] || current[0].lastIndexedHeight!==height-1 || current[0].lastIndexedBlockHash!==expectedPrevHash) throw new Error('Bitcoin cursor changed in another worker');
  }
  for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
    const tx = block.txs[txIndex]!;
    const envelopeResult = decodeTacit(tx);

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
    if (process.env.PARITY_INDEXING_ENABLED === 'true') {
      await persistObservations(writer, tx, ctx);
    }
    if (!envelopeResult) continue;
    const { result, rawWitness } = envelopeResult;
    await writer.delete(schema.commitments).where(and(eq(schema.commitments.network,network),eq(schema.commitments.txid,tx.txid)));
    await persistEnvelope(writer, tx, ctx, result, rawWitness);
    addresses.push(tx);
    processed++;
  }
  if (process.env.PARITY_INDEXING_ENABLED === 'true') {
    // Batched source-outpoint lookup covers ordinary spends and same-block outputs.
    const inputs = block.txs.flatMap(tx => tx.vin.filter(v=>!v.is_coinbase).map(v=>({txid:v.txid,vout:v.vout,spending:tx.txid})));
    for (let i=0;i<inputs.length;i+=2000) {
      await writer.execute(sql`INSERT INTO protocol_spends(network,source_txid,source_vout,spending_txid,block_height,block_hash)
        SELECT ${network},i.txid,i.vout,i.spending,${height},${block.hash}
        FROM jsonb_to_recordset(${JSON.stringify(inputs.slice(i,i+2000))}::jsonb) AS i(txid text,vout integer,spending text)
        WHERE EXISTS(SELECT 1 FROM commitments c WHERE c.network=${network} AND c.txid=i.txid AND c.vout=i.vout)
          OR EXISTS(SELECT 1 FROM protocol_outputs o WHERE o.network=${network} AND o.txid=i.txid AND o.vout=i.vout)
          OR EXISTS(SELECT 1 FROM protocol_validation_jobs j WHERE j.network=${network} AND j.txid=i.txid AND j.vout=i.vout)
        ON CONFLICT(network,source_txid,source_vout) DO UPDATE SET spending_txid=EXCLUDED.spending_txid,block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash`);
    }
  }
  await writer.insert(schema.blocks).values({network,height,blockHash:block.hash,blockTime})
    .onConflictDoUpdate({target:[schema.blocks.network,schema.blocks.height],set:{blockHash:block.hash,blockTime,processedAt:new Date()}});
  if (process.env.PARITY_INDEXING_ENABLED==='true') await writer.execute(sql`INSERT INTO protocol_scan_windows(source,first_height,last_height,block_hash,revision,decoder_version) VALUES(${'bitcoin:'+network},${height},${height},${block.hash},${PROTOCOL_REVISION},${DECODER_VERSION}) ON CONFLICT(source,first_height,last_height) DO UPDATE SET block_hash=EXCLUDED.block_hash,revision=EXCLUDED.revision,decoder_version=EXCLUDED.decoder_version,completed_at=now()`);
  if (advanceCursor && process.env.PARITY_INDEXING_ENABLED==='true') await writer.execute(sql`INSERT INTO protocol_cursors(source,height,block_hash) VALUES(${'bitcoin:'+network},${height},${block.hash}) ON CONFLICT(source) DO UPDATE SET height=EXCLUDED.height,block_hash=EXCLUDED.block_hash,updated_at=now(),error=NULL`);
  if (advanceCursor) await writer.update(schema.cursor).set({lastIndexedHeight:height,lastIndexedBlockHash:block.hash,updatedAt:new Date()}).where(eq(schema.cursor.network,network));
  });
  // Address enrichment is optional and cannot hold the canonical block transaction open.
  for (const tx of addresses) await indexTxAddresses(source,network,tx).catch(e=>console.warn(`[addresses] ${tx.txid}: ${e.message}`));
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

          break;
        }
        totalProcessed += processed;
        cursor = { height: h, hash: blockHash };

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
      cursor = await getOrInitCursor(cfg.network,cfg.startHeight).catch(()=>cursor);
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
