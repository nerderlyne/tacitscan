// Mempool poller. Watches unconfirmed txs for Tacit envelopes so the
// explorer can show them with "0 confirmations" before they land in a
// block — same as Etherscan's pending-tx pages.
//
// Strategy:
//   - every MEMPOOL_POLL_SEC, fetch the current mempool txid set
//   - diff against an in-memory "seen" set (initialised empty on boot)
//   - for each new txid, fetch the tx body and run the envelope decoder
//     with the magic-byte pre-filter; ~95%+ of mempool txs short-circuit
//     before any allocation
//   - matches insert as chain_status='mempool' rows (block fields null);
//     the block walker promotes them via ON CONFLICT DO UPDATE when the
//     tx lands. Assets and commitments are NOT inserted at this stage —
//     they wait for confirmation so the asset registry / utxo views
//     don't include un-confirmed entries.
//   - prune the seen-set periodically by intersecting with the current
//     mempool set (keeps it bounded at ~mempool size).
//
// Concurrency: at most MEMPOOL_TX_CONCURRENCY parallel /tx fetches per
// tick. Mempool churn is ~5–10 new txs/sec on mainnet, so a tick that
// arrives every 5s has 25–50 fresh fetches to do.
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "./db.js";
import { hexToBytes } from "./envelope.js";
import type { EsploraTx } from "./esplora.js";
import { containsMagic, decodeTacit } from "./indexer.js";
import { loadConfig } from "./indexer.js";
import { EsploraClient } from "./esplora.js";
import { BitcoinRpcClient } from "./rpc.js";
import { withFallback, type BitcoinDataSource } from "./source.js";

function buildSource(): BitcoinDataSource {
  const cfg = loadConfig();
  const esplora = new EsploraClient(cfg.esploraUrl, cfg.esploraFallback);
  if (cfg.rpcUrls.length) {
    const rpc = new BitcoinRpcClient(cfg.rpcUrls);
    return withFallback(rpc, esplora);
  }
  return esplora;
}

async function tryDecodeTx(tx: EsploraTx): Promise<ReturnType<typeof decodeTacit>> {
  // Cheap magic-byte check before doing any real work. Reject coinbase
  // and any tx whose vin[0] doesn't carry a witness payload.
  const w = tx.vin[0]?.witness;
  if (!w || w.length < 2) return null;
  try {
    const raw = hexToBytes(w[1]!);
    if (!containsMagic(raw)) return null;
  } catch {
    return null;
  }
  return decodeTacit(tx);
}

async function insertMempoolEnvelope(
  network: string,
  tx: EsploraTx,
  decoded: NonNullable<ReturnType<typeof decodeTacit>>,
): Promise<void> {
  const { result, rawWitness } = decoded;
  if (!result.ok) {
    await db
      .insert(schema.envelopes)
      .values({
        txid: tx.txid,
        network,
        opcode: "UNKNOWN",
        // Block fields null; chain_status='mempool' identifies the row.
        inputCount: tx.vin.length,
        outputCount: tx.vout.length,
        feeSats: tx.fee == null ? null : BigInt(tx.fee),
        rawWitness,
        rawPayload: result.rawPayload ?? new Uint8Array(0),
        status: "malformed",
        decodeError: result.reason,
        chainStatus: "mempool",
      })
      .onConflictDoNothing();
    return;
  }
  const env = result.envelope;
  // Decoded shape-specific scalars we can safely surface even before
  // confirmation. Anything that needs an asset/commitment row is deferred
  // to the block walker.
  const insertVals: typeof schema.envelopes.$inferInsert = {
    txid: tx.txid,
    network,
    opcode: env.opcode,
    assetId: "assetId" in env ? env.assetId : null,
    inputCount: tx.vin.length,
    outputCount: tx.vout.length,
    feeSats: tx.fee == null ? null : BigInt(tx.fee),
    rawWitness,
    rawPayload: result.rawPayload,
    status: "ok",
    chainStatus: "mempool",
    etchTxid: "etchTxid" in env ? env.etchTxid : null,
    publicAmount: env.opcode === "T_PMINT" ? env.amount : env.opcode === "T_BURN" ? env.burnedAmount : null,
    burnedAmount: env.opcode === "T_BURN" ? env.burnedAmount : null,
    n: "n" in env ? env.n : env.opcode === "CETCH" || env.opcode === "T_MINT" || env.opcode === "T_PMINT" || env.opcode === "T_WITHDRAW" ? 1 : null,
    assetInputCount: env.opcode === "T_AXFER" ? env.assetInputCount : null,
    denomination:
      env.opcode === "T_DEPOSIT"
        ? env.isPoolInit
          ? env.poolDenom
          : env.denomination
        : env.opcode === "T_WITHDRAW"
          ? env.denomination
          : null,
    isPoolInit: env.opcode === "T_DEPOSIT" ? env.isPoolInit : false,
  };
  await db.insert(schema.envelopes).values(insertVals).onConflictDoNothing();
}

async function pollOnce(
  source: BitcoinDataSource,
  network: string,
  seen: Set<string>,
  concurrency: number,
): Promise<{ scanned: number; found: number }> {
  let txids: string[];
  try {
    txids = await source.getMempoolTxids();
  } catch (e) {
    console.warn(`[mempool] getMempoolTxids failed: ${(e as Error).message}`);
    return { scanned: 0, found: 0 };
  }

  // Diff: only fetch tx bodies for IDs we haven't already inspected this run.
  const fresh: string[] = [];
  for (const id of txids) if (!seen.has(id)) fresh.push(id);

  let found = 0;
  let scanned = 0;

  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, fresh.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= fresh.length) return;
      const txid = fresh[i]!;
      seen.add(txid);
      scanned++;
      let tx: EsploraTx;
      try {
        tx = await source.fetchTx(txid);
      } catch {
        // Tx may have been evicted between the listing and the fetch —
        // ignore; next poll will pick it up if it reappears.
        return;
      }
      const decoded = await tryDecodeTx(tx);
      if (!decoded) return;
      try {
        await insertMempoolEnvelope(network, tx, decoded);
        found++;
      } catch (e) {
        console.error(`[mempool] insert failed tx=${txid}:`, e);
      }
    }
  });
  await Promise.all(workers);

  // Periodic prune: keep seen-set close to mempool size by dropping any
  // ids that aren't in the current snapshot. Done unconditionally on each
  // poll — O(seen.size) but tiny vs. the network IO.
  if (seen.size > txids.length * 1.5) {
    const live = new Set(txids);
    for (const id of seen) if (!live.has(id)) seen.delete(id);
  }
  return { scanned, found };
}

// Drop envelope rows that have been sitting in 'mempool' longer than the
// timeout — these are txs that were broadcast, picked up by us, and then
// silently evicted from every node's mempool without confirming. Matches
// Bitcoin Core's default 2-week mempool expiry.
async function expireOldMempool(network: string, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const dropped = await db
    .delete(schema.envelopes)
    .where(
      and(
        eq(schema.envelopes.network, network),
        eq(schema.envelopes.chainStatus, "mempool"),
        lt(schema.envelopes.firstSeenAt, cutoff),
      ),
    )
    .returning({ txid: schema.envelopes.txid });
  return dropped.length;
}

export async function runMempoolPoller(): Promise<never> {
  const cfg = loadConfig();
  const source = buildSource();
  const pollSec = Number(process.env.MEMPOOL_POLL_SEC ?? 5);
  const concurrency = Number(process.env.MEMPOOL_TX_CONCURRENCY ?? 8);
  const seen = new Set<string>();
  console.log(`[mempool] starting on ${cfg.network}, source=${source.name}, poll=${pollSec}s, concurrency=${concurrency}`);

  // Sweep stale mempool rows roughly once an hour. 14 days mirrors
  // Bitcoin Core's default mempool expiry — anything older than that
  // was almost certainly evicted, not still pending.
  const sweepEveryMs = 60 * 60 * 1000;
  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  let nextSweepAt = Date.now() + sweepEveryMs;

  while (true) {
    const startedAt = Date.now();
    const { scanned, found } = await pollOnce(source, cfg.network, seen, concurrency);
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (scanned > 0) {
      console.log(`[mempool] scanned ${scanned} new txs (+${found} tacit) in ${took}s, seen=${seen.size}`);
    }
    if (Date.now() >= nextSweepAt) {
      try {
        const n = await expireOldMempool(cfg.network, maxAgeMs);
        if (n > 0) console.log(`[mempool] expired ${n} stale mempool rows older than 14d`);
      } catch (e) {
        console.warn(`[mempool] expireOldMempool failed: ${(e as Error).message}`);
      }
      nextSweepAt = Date.now() + sweepEveryMs;
    }
    await sleep(pollSec * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
