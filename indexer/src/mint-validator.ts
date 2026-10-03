// Background T_MINT issuer-signature validator. Runs alongside the
// block walker, T_PMINT validator, and image resolver.
//
// Per SPEC §5.3 a T_MINT is only a real mint if all of these hold:
//   1. asset_id == SHA256(reverse(etch_txid_bytes) || vout=0)  (already
//      enforced at index time; status = 'malformed' on mismatch)
//   2. parent envelope at etch_txid is a CETCH and its mint_authority is
//      non-zero (the asset was etched as mintable)
//   3. issuer_sig is a valid BIP-340 Schnorr sig over
//        mint_msg = SHA256(
//          "tacit-mint-v1"
//          || asset_id (32)
//          || commit_anchor (36)
//          || commitment (33)
//          || amount_ct (8)
//        )
//      under mint_authority (x-only).
//
// commit_anchor = commit_tx.vin[0].txid_BE || commit_tx.vin[0].vout_LE,
// where commit_tx is the parent of the reveal_tx via reveal_tx.vin[0].
// We don't store either of those at index time, so the validator fetches
// them from Esplora on demand. T_MINTs are rare (only mintable CETCHes
// can produce them, only the issuer can sign), so the per-row cost of
// 2 HTTP calls is fine.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "./db.js";

const BATCH_SIZE = 50;
const IDLE_POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 6000;
const ESPLORA_BASE = process.env.ESPLORA_URL ?? (process.env.BITCOIN_NETWORK === "signet" ? "https://mempool.space/signet/api" : "https://mempool.space/api");

interface MintRow {
  txid: string;
  blockHash: string;
  assetId: string | null;
  etchTxid: string | null;
  issuerSig: Uint8Array | null;
  commitmentC: Uint8Array | null;
  amountCt: Uint8Array | null;
}

async function fetchUnverifiedBatch(): Promise<MintRow[]> {
  // amount_ct lives in commitments.encrypted_amount; commitment is also
  // there. issuer_sig is on envelopes directly.
  const rows = await db.execute<{
    txid: string;
    block_hash: string;
    asset_id: string | null;
    etch_txid: string | null;
    issuer_sig: Buffer | null;
    commitment_c: Buffer | null;
    encrypted_amount: Buffer | null;
  }>(sql`
    SELECT e.txid, e.block_hash, e.asset_id, e.etch_txid, e.issuer_sig,
           c.commitment_c, c.encrypted_amount
    FROM envelopes e
    LEFT JOIN commitments c ON c.txid = e.txid AND c.vout = 0
    WHERE e.opcode = 'T_MINT'
      AND e.network = ${process.env.BITCOIN_NETWORK ?? 'mainnet'}
      AND e.status = 'ok'
      AND e.chain_status = 'confirmed'
      AND e.issuer_sig_valid IS NULL
    ORDER BY e.issuer_sig_checked_at ASC NULLS FIRST, e.block_height ASC
    LIMIT ${BATCH_SIZE}
  `);
  return rows.map((r) => ({
    txid: r.txid,
    blockHash: r.block_hash,
    assetId: r.asset_id,
    etchTxid: r.etch_txid,
    issuerSig: r.issuer_sig ? new Uint8Array(r.issuer_sig) : null,
    commitmentC: r.commitment_c ? new Uint8Array(r.commitment_c) : null,
    amountCt: r.encrypted_amount ? new Uint8Array(r.encrypted_amount) : null,
  }));
}

async function fetchTxVin0(txid: string): Promise<{ txid: string; vout: number } | null> {
  try {
    const r = await fetch(`${ESPLORA_BASE}/tx/${txid}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "tacitscan-mint-validator/0.1" },
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { vin?: Array<{ txid?: string; vout?: number }> };
    const v0 = data.vin?.[0];
    if (!v0?.txid || typeof v0.vout !== "number") return null;
    return { txid: v0.txid, vout: v0.vout };
  } catch {
    return null;
  }
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

const TACIT_MINT_V1 = new TextEncoder().encode("tacit-mint-v1");

// commit_anchor = commit_tx.vin[0].txid_BE || commit_tx.vin[0].vout_LE.
// Per SPEC §3.5 _BE here means natural hash bytes (= reverse of displayed
// hex). We hex-decode the displayed txid then reverse, matching the
// derivation that worked for asset_id.
function buildCommitAnchor(commitTxidDisplayed: string, commitVout: number): Uint8Array {
  const txidBytes = hexToBytes(commitTxidDisplayed).reverse();
  const voutBytes = new Uint8Array(4);
  voutBytes[0] = commitVout & 0xff;
  voutBytes[1] = (commitVout >>> 8) & 0xff;
  voutBytes[2] = (commitVout >>> 16) & 0xff;
  voutBytes[3] = (commitVout >>> 24) & 0xff;
  return concat(txidBytes, voutBytes);
}

async function getMintAuthority(etchTxid: string): Promise<{ ok: boolean; pending?: boolean; pubkey?: Uint8Array; reason?: string }> {
  const parents = await db
    .select({
      kind: schema.assets.kind,
      mintAuthority: schema.assets.mintAuthority,
    })
    .from(schema.assets)
    .where(eq(schema.assets.etchTxid, etchTxid))
    .limit(1);
  const parent = parents[0];
  if (!parent) return { ok: false, pending: true, reason: "parent CETCH is not indexed yet" };
  if (parent.kind !== "cetch") return { ok: false, reason: `parent kind=${parent.kind}, expected cetch` };
  if (!parent.mintAuthority) return { ok: false, reason: "parent CETCH is non-mintable (mint_authority = 0)" };
  return { ok: true, pubkey: hexToBytes(parent.mintAuthority) };
}

async function validateOne(row: MintRow): Promise<{ valid: boolean | null; reason?: string }> {
  if (!row.assetId) return { valid: false, reason: "missing asset_id" };
  if (!row.etchTxid) return { valid: false, reason: "missing etch_txid" };
  if (!row.issuerSig || row.issuerSig.length !== 64) return { valid: false, reason: "missing or malformed issuer_sig" };
  if (!row.commitmentC || row.commitmentC.length !== 33) return { valid: false, reason: "missing commitment" };
  if (!row.amountCt || row.amountCt.length !== 8) return { valid: false, reason: "missing amount_ct" };

  const auth = await getMintAuthority(row.etchTxid);
  if (!auth.ok || !auth.pubkey) return { valid: auth.pending ? null : false, reason: auth.reason ?? "mint_authority lookup failed" };

  // Two HTTP fetches per T_MINT to derive the commit_anchor:
  //   reveal_tx.vin[0]    → tells us the commit tx outpoint
  //   commit_tx.vin[0]    → the actual anchor outpoint
  const reveal = await fetchTxVin0(row.txid);
  if (!reveal) return { valid: null, reason: "could not fetch reveal_tx.vin[0]" };
  const commit = await fetchTxVin0(reveal.txid);
  if (!commit) return { valid: null, reason: "could not fetch commit_tx.vin[0]" };

  const anchor = buildCommitAnchor(commit.txid, commit.vout);
  const assetIdBytes = hexToBytes(row.assetId);
  const mintMsg = sha256(concat(TACIT_MINT_V1, assetIdBytes, anchor, row.commitmentC, row.amountCt));

  let ok = false;
  try {
    ok = schnorr.verify(row.issuerSig, mintMsg, auth.pubkey);
  } catch (e) {
    return { valid: false, reason: `schnorr verify threw: ${(e as Error).message}` };
  }
  return ok ? { valid: true } : { valid: false, reason: "schnorr signature does not verify under mint_authority" };
}

async function persistResult(row: MintRow, valid: boolean | null, reason?: string): Promise<void> {
  await db
    .update(schema.envelopes)
    .set({
      issuerSigValid: valid,
      issuerSigCheckedAt: new Date(),
      issuerSigInvalidReason: valid ? null : (reason ?? "unknown").slice(0, 500),
    })
    .where(sql`${schema.envelopes.txid}=${row.txid} AND ${schema.envelopes.blockHash}=${row.blockHash} AND ${schema.envelopes.chainStatus}='confirmed'`);
}

export async function runMintValidator(): Promise<never> {
  console.log("[mint-validator] started");
  while (true) {
    const batch = await fetchUnverifiedBatch();
    if (batch.length === 0) {
      await sleep(IDLE_POLL_MS);
      continue;
    }
    const startedAt = Date.now();
    let valid = 0;
    let invalid = 0;
    for (const row of batch) {
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
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    await sleep(IDLE_POLL_MS);
    console.log(`[mint-validator] batch: +${valid} valid, ${invalid} invalid in ${took}s`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
