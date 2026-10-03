// Background T_PMINT validator. Runs alongside the block walker and image
// resolver. Picks up T_PMINT envelopes that haven't been verified yet
// and runs the SPEC §5.5/§5.9 checks the byte-shape decoder couldn't:
//
//   1. parent envelope at etch_txid is T_PETCH
//   2. amount == petch.mint_limit
//   3. pedersenCommit(amount, blinding) == commitment
//
// (cap-overflow ordering and the height window are enforced at query time
// in the frontend so they recompute correctly under reorgs without
// rewriting per-row state.)
//
// Each row is checked once. Result is written to commitment_valid,
// commitment_checked_at, commitment_invalid_reason on envelopes.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "./db.js";
import { verifyPedersen } from "./pedersen.js";

const BATCH_SIZE = 200;
const IDLE_POLL_MS = 30_000;

interface PMintRow {
  txid: string;
  blockHash: string;
  assetId: string | null;
  etchTxid: string | null;
  blockHeight: number;
  publicAmount: bigint | null;
  blinding: Uint8Array | null;
  commitmentC: Uint8Array | null;
}

async function fetchUnverifiedBatch(): Promise<PMintRow[]> {
  // JOIN commitments to pull blinding + commitment_c that the indexer
  // already saved when it ingested the T_PMINT.
  const rows = await db.execute<{
    txid: string;
    block_hash: string;
    asset_id: string | null;
    etch_txid: string | null;
    block_height: number;
    public_amount: string | null;
    blinding: Buffer | null;
    commitment_c: Buffer | null;
  }>(sql`
    SELECT e.txid, e.block_hash, e.asset_id, e.etch_txid, e.block_height,
           e.public_amount::text AS public_amount,
           c.public_blinding AS blinding, c.commitment_c
    FROM envelopes e
    LEFT JOIN commitments c ON c.txid = e.txid AND c.vout = 0
    WHERE e.opcode = 'T_PMINT'
      AND e.network = ${process.env.BITCOIN_NETWORK ?? 'mainnet'}
      AND e.status = 'ok'
      AND e.chain_status = 'confirmed'
      AND e.commitment_valid IS NULL
    ORDER BY e.commitment_checked_at ASC NULLS FIRST, e.block_height ASC
    LIMIT ${BATCH_SIZE}
  `);

  return rows.map((r) => ({
    txid: r.txid,
    blockHash: r.block_hash,
    assetId: r.asset_id,
    etchTxid: r.etch_txid,
    blockHeight: r.block_height,
    publicAmount: r.public_amount ? BigInt(r.public_amount) : null,
    blinding: r.blinding ? new Uint8Array(r.blinding) : null,
    commitmentC: r.commitment_c ? new Uint8Array(r.commitment_c) : null,
  }));
}

interface ParentInfo {
  ok: boolean;
  mintLimit: bigint | null;
  etchHeight: number | null;
  mintStartHeight: number | null;
  mintEndHeight: number | null;
  reason?: string;
}

// Process-lifetime cache. Most validation runs see the same handful of
// T_PETCHes repeatedly (e.g. FAIR has 221k+ T_PMINTs all pointing at
// the same parent). Without this each row hit the assets table fresh —
// the dominant cost in the loop. Cache is unbounded; the parent set is
// small (one row per T_PETCH ever).
const parentCache = new Map<string, ParentInfo>();
let parentGeneration=0;
export function clearParentCache() { parentGeneration++; parentCache.clear(); }

async function checkParent(etchTxid: string): Promise<ParentInfo> {
  const cached=parentCache.get(etchTxid);
  if(cached) return cached;
  const generation=parentGeneration;
  const parents = await db
    .select({
      kind: schema.assets.kind,
      mintLimit: schema.assets.mintLimit,
      etchHeight: schema.assets.etchHeight,
      mintStartHeight: schema.assets.mintStartHeight,
      mintEndHeight: schema.assets.mintEndHeight,
    })
    .from(schema.assets)
    .where(eq(schema.assets.etchTxid, etchTxid))
    .limit(1);
  const parent = parents[0];
  let info: ParentInfo;
  if (!parent) {
    info = {
      ok: false,
      mintLimit: null,
      etchHeight: null,
      mintStartHeight: null,
      mintEndHeight: null,
      reason: "etch_txid has no T_PETCH ancestor",
    };
  } else if (parent.kind !== "t_petch") {
    info = {
      ok: false,
      mintLimit: null,
      etchHeight: null,
      mintStartHeight: null,
      mintEndHeight: null,
      reason: `parent kind=${parent.kind}, expected t_petch`,
    };
  } else {
    info = {
      ok: true,
      mintLimit: parent.mintLimit,
      etchHeight: parent.etchHeight,
      mintStartHeight: parent.mintStartHeight,
      mintEndHeight: parent.mintEndHeight,
    };
  }
  // Don't cache "no parent yet" results — the T_PETCH may show up in a
  // future block and we want to re-look. Cache permanent hits + permanent
  // misses (kind != t_petch).
  if (generation===parentGeneration && (info.ok || info.reason?.startsWith("parent kind="))) {
    parentCache.set(etchTxid, info);
  }
  return info;
}

async function validateOne(row: PMintRow): Promise<{ valid: boolean | null; reason?: string }> {
  if (!row.etchTxid) return { valid: false, reason: "missing etch_txid" };
  if (row.publicAmount === null) return { valid: false, reason: "missing amount" };
  if (!row.blinding) return { valid: false, reason: "missing blinding" };
  if (!row.commitmentC) return { valid: false, reason: "missing commitment" };

  const parent = await checkParent(row.etchTxid);
  if (!parent.ok) return { valid: parent.reason?.includes("no T_PETCH") ? null : false, reason: parent.reason ?? "parent not valid" };

  if (parent.mintLimit !== null && row.publicAmount !== parent.mintLimit) {
    return { valid: false, reason: `amount ${row.publicAmount} != mint_limit ${parent.mintLimit}` };
  }

  // SPEC §5.9 step 4: confirmed_height ∈ [effective_start, effective_end].
  // effective_start = mint_start_height (if non-zero) else etch_height + 1.
  // effective_end   = mint_end_height (if non-zero) else infinity.
  // The "etch_height + 1" rule is the structural defense against
  // same-block deployer pre-mining ("zero deployer allocation"), and is
  // the rule that filters the bulk of pre-deploy spam envelopes.
  //
  // Defense-in-depth: even if a malformed T_PETCH made it into our DB
  // before handlers.ts started rejecting them, clamp effective_start to
  // be at least etch_height + 1 here too. That way same-block premines
  // can never credit even against a permissive parent.
  if (parent.etchHeight !== null) {
    const startRaw = parent.mintStartHeight ?? 0;
    const declared = startRaw !== 0 ? startRaw : parent.etchHeight + 1;
    const effectiveStart = Math.max(declared, parent.etchHeight + 1);
    if (row.blockHeight < effectiveStart) {
      return {
        valid: false,
        reason: `height ${row.blockHeight} < effective_start ${effectiveStart}`,
      };
    }
    const endRaw = parent.mintEndHeight ?? 0;
    if (endRaw !== 0 && row.blockHeight > endRaw) {
      return {
        valid: false,
        reason: `height ${row.blockHeight} > mint_end_height ${endRaw}`,
      };
    }
  }

  const ped = verifyPedersen(row.publicAmount, row.blinding, row.commitmentC);
  if (!ped.ok) return { valid: false, reason: ped.reason ?? "pedersen failed" };

  return { valid: true };
}

async function persistResult(row: PMintRow, valid: boolean | null, reason?: string): Promise<void> {
  await db
    .update(schema.envelopes)
    .set({
      commitmentValid: valid,
      commitmentCheckedAt: new Date(),
      commitmentInvalidReason: valid ? null : (reason ?? "unknown").slice(0, 500),
    })
    .where(sql`${schema.envelopes.txid}=${row.txid} AND ${schema.envelopes.blockHash}=${row.blockHash} AND ${schema.envelopes.chainStatus}='confirmed'`);
}

export async function runValidator(): Promise<never> {
  console.log("[validator] started");
  while (true) {
    const batch = await fetchUnverifiedBatch();
    if (batch.length === 0) {
      await sleep(IDLE_POLL_MS);
      continue;
    }
    const startedAt = Date.now();
    let valid = 0;
    let invalid = 0;
    // Process the batch with bounded concurrency. Each row's CPU cost
    // (Pedersen multi-mul) is ~0.5ms; the dominant wall time is the per-
    // row UPDATE, which Postgres can pipeline in parallel. 16 in flight
    // saturates a typical Postgres pool without contention.
    const work = [...batch];
    const concurrency = 16;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, work.length) }, async () => {
        while (work.length > 0) {
          const row = work.shift();
          if (!row) return;
          try {
            const r = await validateOne(row);
            await persistResult(row, r.valid, r.reason);
            if (r.valid) valid++;
            else if(r.valid===false) invalid++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await persistResult(row, null, `retry: ${msg}`).catch(() => undefined);
            invalid++;
          }
        }
      }),
    );
    if(valid+invalid===0) await sleep(IDLE_POLL_MS);
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[validator] batch: +${valid} valid, ${invalid} invalid in ${took}s (rate=${(batch.length / Math.max(0.1, Number(took))).toFixed(0)}/s)`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
