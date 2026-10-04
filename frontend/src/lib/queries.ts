import { cached } from "./cache";
import { TRANSFER_OPS } from "./protocol";
const NETWORK = import.meta.env.PUBLIC_NETWORK ?? "mainnet";
import { and, desc, eq, ilike, or, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db";

export async function getRecentEnvelopes(limit = 25) {
  // Split mempool/confirmed reads so confirmed rows use the existing
  // (network, block_height) index instead of sorting all history by CASE.
  const query = (status: string) => db
    .select({
      txid: schema.envelopes.txid,
      opcode: schema.envelopes.opcode,
      assetId: schema.envelopes.assetId,
      blockHeight: schema.envelopes.blockHeight,
      blockTime: schema.envelopes.blockTime,
      chainStatus: schema.envelopes.chainStatus,
      firstSeenAt: schema.envelopes.firstSeenAt,
      n: schema.envelopes.n,
      publicAmount: schema.envelopes.publicAmount,
      ticker: schema.assets.ticker,
      decimals: schema.assets.decimals,
    })
    .from(schema.envelopes)
    .leftJoin(schema.assets, eq(schema.envelopes.assetId, schema.assets.assetId))
    .where(and(eq(schema.envelopes.network, NETWORK), eq(schema.envelopes.chainStatus, status)));
  const [mempool, confirmed] = await Promise.all([
    query('mempool').orderBy(desc(schema.envelopes.firstSeenAt)).limit(limit),
    query('confirmed').orderBy(desc(schema.envelopes.blockHeight), desc(schema.envelopes.txIndex)).limit(limit),
  ]);
  return [...mempool, ...confirmed].slice(0, limit);
}

export async function getAssetsDirectory(opts: { limit?: number; offset?: number; q?: string } = {}) {
  const { limit = 50, offset = 0, q } = opts;
  const where = and(eq(schema.assets.network, NETWORK), q ? ilike(schema.assets.ticker, `%${q}%`) : undefined);
  return db
    .select()
    .from(schema.assets)
    .where(where)
    .orderBy(desc(schema.assets.etchHeight))
    .limit(limit)
    .offset(offset);
}

export async function getAssetsCount(q?: string): Promise<number> {
  const rows = q
    ? await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM assets WHERE network=${NETWORK} AND ticker ILIKE ${"%" + q + "%"}`)
    : await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM assets WHERE network=${NETWORK}`);
  return rows[0]?.c ?? 0;
}

export async function getAsset(assetId: string) {
  const rows = await db.select().from(schema.assets).where(and(eq(schema.assets.network, NETWORK), eq(schema.assets.assetId, assetId))).limit(1);
  return rows[0] ?? null;
}

export interface MintRow {
  txid: string;
  opcode: string;
  blockHeight: number | null;
  blockTime: Date | null;
  publicAmount: bigint | null;
  chainStatus: string;
  firstSeenAt: Date;
  commitmentValid: boolean | null;
  commitmentInvalidReason: string | null;
  issuerSigValid: boolean | null;
  issuerSigInvalidReason: string | null;
  /** "credited" | "cap-overflow" | "pending" | "invalid" | "mempool" | "ok" */
  status: string;
}

// Returns mints with per-row status. For T_PMINT we apply the SPEC §5.9
// cap-overflow rule using a window function: first slotsTotal valid rows
// in canonical (block_height, tx_index) order are 'credited', rest are
// 'cap-overflow'. Invalid/pending rows are tagged separately.
export async function getAssetMints(
  assetId: string,
  capAmount: bigint | null,
  mintLimit: bigint | null,
  limit = 50,
): Promise<MintRow[]> {
  const slotsTotal =
    capAmount && mintLimit && mintLimit > 0n ? (capAmount / mintLimit).toString() : '18446744073709551615';
  const rows = await db.execute<{
    txid: string;
    opcode: string;
    block_height: number | null;
    block_time: Date | null;
    public_amount: string | null;
    chain_status: string;
    first_seen_at: Date;
    commitment_valid: boolean | null;
    commitment_invalid_reason: string | null;
    issuer_sig_valid: boolean | null;
    issuer_sig_invalid_reason: string | null;
    status: string;
  }>(sql`
    WITH ranked AS (
      SELECT
        e.txid, e.opcode, e.block_height, e.block_time, e.tx_index,
        e.chain_status, e.first_seen_at,
        e.public_amount::text AS public_amount,
        e.commitment_valid, e.commitment_invalid_reason,
        e.issuer_sig_valid, e.issuer_sig_invalid_reason,
        ROW_NUMBER() OVER (
          PARTITION BY e.asset_id, e.opcode
          ORDER BY
            CASE WHEN e.opcode = 'T_PMINT' AND e.commitment_valid = true AND e.chain_status = 'confirmed' THEN 0
                 WHEN e.opcode = 'T_MINT' AND e.issuer_sig_valid = true AND e.chain_status = 'confirmed' THEN 0
                 ELSE 1
            END,
            e.block_height ASC NULLS LAST, e.tx_index ASC NULLS LAST
        ) AS valid_rank
      FROM envelopes e
      WHERE e.network=${NETWORK} AND e.asset_id = ${assetId}
        AND e.opcode IN ('T_MINT', 'T_PMINT')
        AND e.status = 'ok'
        AND e.chain_status <> 'orphaned'
    )
    SELECT
      txid, opcode, block_height, block_time, public_amount,
      chain_status, first_seen_at,
      commitment_valid, commitment_invalid_reason,
      issuer_sig_valid, issuer_sig_invalid_reason,
      CASE
        WHEN chain_status = 'mempool' THEN 'mempool'
        WHEN opcode = 'T_PMINT' AND commitment_valid IS NULL THEN 'pending'
        WHEN opcode = 'T_PMINT' AND commitment_valid = false THEN 'invalid'
        WHEN opcode = 'T_PMINT' AND valid_rank <= ${slotsTotal}::numeric THEN 'credited'
        WHEN opcode = 'T_PMINT' THEN 'cap-overflow'
        WHEN opcode = 'T_MINT' AND issuer_sig_valid IS NULL THEN 'pending'
        WHEN opcode = 'T_MINT' AND issuer_sig_valid = false THEN 'invalid'
        WHEN opcode = 'T_MINT' AND issuer_sig_valid = true THEN 'credited'
        ELSE 'ok'
      END AS status
    FROM ranked
    ORDER BY (chain_status = 'mempool') DESC, block_height DESC NULLS FIRST, txid DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    txid: r.txid,
    opcode: r.opcode,
    blockHeight: r.block_height,
    blockTime: r.block_time ? new Date(r.block_time) : null,
    publicAmount: r.public_amount ? BigInt(r.public_amount) : null,
    chainStatus: r.chain_status,
    firstSeenAt: new Date(r.first_seen_at),
    commitmentValid: r.commitment_valid,
    commitmentInvalidReason: r.commitment_invalid_reason,
    issuerSigValid: r.issuer_sig_valid,
    issuerSigInvalidReason: r.issuer_sig_invalid_reason,
    status: r.status,
  }));
}

export async function getAssetBurns(assetId: string, limit = 50) {
  return db
    .select()
    .from(schema.envelopes)
    .where(and(and(eq(schema.envelopes.network, NETWORK), eq(schema.envelopes.assetId, assetId)), eq(schema.envelopes.opcode, "T_BURN"), eq(schema.envelopes.chainStatus, "confirmed"), eq(schema.envelopes.status, "ok")))
    .orderBy(desc(schema.envelopes.blockHeight))
    .limit(limit);
}

export async function getAssetTransfers(assetId: string, limit = 50) {
  return db
    .select()
    .from(schema.envelopes)
    .where(
      and(
        and(eq(schema.envelopes.network, NETWORK), eq(schema.envelopes.assetId, assetId)),
        inArray(schema.envelopes.opcode, TRANSFER_OPS),
        eq(schema.envelopes.chainStatus, "confirmed"),
        eq(schema.envelopes.status, "ok"),
      ),
    )
    .orderBy(desc(schema.envelopes.blockHeight))
    .limit(limit);
}

export async function getAssetCounts(assetId: string) {
  const rows = await db.execute<{ opcode: string; cnt: number }>(sql`
    SELECT opcode, COUNT(*)::int AS cnt
    FROM envelopes
    WHERE network=${NETWORK} AND asset_id = ${assetId} AND chain_status = 'confirmed'
    GROUP BY opcode
  `);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.opcode] = r.cnt;
  return counts;
}

export async function getCumulativeMinted(assetId: string): Promise<bigint> {
  const rows = await db.execute<{ s: string | null }>(sql`
    SELECT COALESCE(SUM(public_amount), 0)::text AS s
    FROM envelopes
    WHERE network=${NETWORK} AND asset_id = ${assetId}
      AND opcode = 'T_PMINT'
      AND status = 'ok'
      AND chain_status = 'confirmed'
  `);
  const s = rows[0]?.s;
  return s ? BigInt(s) : 0n;
}

// Validated T_PMINT accounting. The indexer's validator loop verifies
// each T_PMINT against SPEC §5.5/§5.9 (Pedersen commitment, parent =
// T_PETCH, amount = mint_limit). Only commitment_valid=true rows count
// toward supply; we then additionally apply the cap-overflow ordering
// rule (canonical block_height, tx_index) and clamp at slotsTotal.
export interface MintStats {
  /** Total T_PMINT envelopes observed (whether or not valid). */
  rawCount: number;
  /** Of those, how many have been verified by the validator loop. */
  checkedCount: number;
  /** Of checked, how many passed full validation. */
  passedCount: number;
  /** Passed AND within the protocol cap (canonical order). */
  effectiveCount: number;
  /** effectiveCount × mint_limit. */
  cumMinted: bigint;
  /** passedCount − effectiveCount: valid mints rejected for cap-overflow. */
  capOverflow: number;
  /** rawCount − checkedCount: not yet reached by the validator loop. */
  pendingCount: number;
  /** True iff effectiveCount has reached slotsTotal. */
  mintedOut: boolean;
}

export async function getMintStats(
  assetId: string,
  capAmount: bigint | null,
  mintLimit: bigint | null,
): Promise<MintStats> {
  const rows = await db.execute<{
    raw: number;
    checked: number;
    passed: number;
  }>(sql`
    SELECT
      COUNT(*)::int AS raw,
      COUNT(commitment_valid)::int AS checked,
      COUNT(*) FILTER (WHERE commitment_valid = true)::int AS passed
    FROM envelopes
    WHERE network=${NETWORK} AND asset_id = ${assetId}
      AND opcode = 'T_PMINT'
      AND status = 'ok'
      AND chain_status = 'confirmed'
  `);
  const r = rows[0] ?? { raw: 0, checked: 0, passed: 0 };
  const rawCount = r.raw;
  const checkedCount = r.checked;
  const passedCount = r.passed;
  const pendingCount = rawCount - checkedCount;

  if (!capAmount || !mintLimit || mintLimit === 0n) {
    return {
      rawCount,
      checkedCount,
      passedCount,
      effectiveCount: passedCount,
      cumMinted: BigInt(passedCount) * (mintLimit ?? 0n),
      capOverflow: 0,
      pendingCount,
      mintedOut: false,
    };
  }
  const slotsTotal = capAmount / mintLimit;
  const effectiveCount = Number(BigInt(passedCount) < slotsTotal ? BigInt(passedCount) : slotsTotal);
  return {
    rawCount,
    checkedCount,
    passedCount,
    effectiveCount,
    cumMinted: BigInt(effectiveCount) * mintLimit,
    capOverflow: passedCount - effectiveCount,
    pendingCount,
    mintedOut: BigInt(effectiveCount) >= slotsTotal,
  };
}

export async function getCumulativeBurned(assetId: string): Promise<bigint> {
  const rows = await db.execute<{ s: string | null }>(sql`
    SELECT COALESCE(SUM(burned_amount), 0)::text AS s
    FROM envelopes
    WHERE network=${NETWORK} AND asset_id = ${assetId} AND opcode = 'T_BURN' AND status = 'ok' AND chain_status='confirmed'
  `);
  const s = rows[0]?.s;
  return s ? BigInt(s) : 0n;
}

export async function getEnvelope(txid: string) {
  const rows = await db
    .select({
      env: schema.envelopes,
      asset: schema.assets,
    })
    .from(schema.envelopes)
    .leftJoin(schema.assets, eq(schema.envelopes.assetId, schema.assets.assetId))
    .where(and(eq(schema.envelopes.network, NETWORK), eq(schema.envelopes.txid, txid)))
    .limit(1);
  return rows[0] ?? null;
}

// Resolve a commit-half txid back to the envelope it funded. Every tacit
// envelope sits in vin[0]'s witness on a P2TR script-path spend, so the
// prior tx is the commit; visiting /tx/<commit_txid> would otherwise 404
// because the commit tx itself carries no envelope.
export async function getEnvelopeByCommitTxid(commitTxid: string) {
  const rows = await db
    .select({
      env: schema.envelopes,
      asset: schema.assets,
    })
    .from(schema.envelopes)
    .leftJoin(schema.assets, eq(schema.envelopes.assetId, schema.assets.assetId))
    .where(and(eq(schema.envelopes.network, NETWORK), eq(schema.envelopes.commitTxid, commitTxid)))
    .limit(1);
  return rows[0] ?? null;
}

export async function setEnvelopeFee(txid: string, feeSats: bigint): Promise<void> {
  await db.update(schema.envelopes).set({ feeSats }).where(and(eq(schema.envelopes.network, NETWORK), eq(schema.envelopes.txid, txid)));
}

// Latest confirmed block height we've indexed. Used for confirmation count
// on tx pages. Reads from the cursor table — single row per network.
export async function getIndexerTipHeight(network: string): Promise<number | null> {
  const row = await db.query.cursor.findFirst({ where: eq(schema.cursor.network, network) });
  return row?.lastIndexedHeight ?? null;
}

// Paginated envelope feed for /activity. Mirrors getRecentEnvelopes'
// sort (mempool first, then confirmed by descending height) but
// supports limit/offset. Excludes orphaned rows.
export async function getEnvelopesPage(opts: { limit?: number; offset?: number; opcode?: string | null } = {}) {
  const { limit = 50, offset = 0, opcode = null } = opts;
  const statusWhere = and(eq(schema.envelopes.network, NETWORK), or(eq(schema.envelopes.chainStatus, "confirmed"), eq(schema.envelopes.chainStatus, "mempool")));
  const where = opcode ? and(statusWhere, eq(schema.envelopes.opcode, opcode)) : statusWhere;
  return db
    .select({
      txid: schema.envelopes.txid,
      opcode: schema.envelopes.opcode,
      assetId: schema.envelopes.assetId,
      blockHeight: schema.envelopes.blockHeight,
      blockTime: schema.envelopes.blockTime,
      chainStatus: schema.envelopes.chainStatus,
      firstSeenAt: schema.envelopes.firstSeenAt,
      n: schema.envelopes.n,
      publicAmount: schema.envelopes.publicAmount,
      ticker: schema.assets.ticker,
      decimals: schema.assets.decimals,
    })
    .from(schema.envelopes)
    .leftJoin(schema.assets, eq(schema.envelopes.assetId, schema.assets.assetId))
    .where(where)
    .orderBy(
      sql`CASE WHEN ${schema.envelopes.chainStatus} = 'mempool' THEN 0 ELSE 1 END`,
      desc(schema.envelopes.blockHeight),
      desc(schema.envelopes.txIndex),
      desc(schema.envelopes.firstSeenAt),
    )
    .limit(limit)
    .offset(offset);
}

export async function getEnvelopesCount(opcode: string | null = null): Promise<number> {
  const rows = opcode
    ? await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM envelopes
        WHERE network=${NETWORK} AND chain_status IN ('confirmed', 'mempool') AND opcode = ${opcode}
      `)
    : await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM envelopes
        WHERE network=${NETWORK} AND chain_status IN ('confirmed', 'mempool')
      `);
  return rows[0]?.c ?? 0;
}

// Per-opcode counts so the filter chip row can show "(N)" next to each
// option without firing one query per opcode.
export async function getOpcodeCounts(): Promise<Record<string, number>> {
  const rows = await db.execute<{ opcode: string; c: number }>(sql`
    SELECT opcode, COUNT(*)::int AS c FROM envelopes
    WHERE network=${NETWORK} AND chain_status IN ('confirmed', 'mempool')
    GROUP BY opcode
    ORDER BY c DESC
  `);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.opcode] = r.c;
  return out;
}

// Address-page queries. All keyed on an x-only pubkey hex (64 chars)
// derived from a bech32m P2TR address. See lib/bech32.decodeP2TR.

export async function getAssetsEtchedBy(network: string, xonlyHex: string) {
  return db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.network, network), eq(schema.assets.creatorPubkey, xonlyHex)))
    .orderBy(desc(schema.assets.etchHeight));
}

export async function getAssetsWithMintAuthority(network: string, xonlyHex: string) {
  return db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.network, network), eq(schema.assets.mintAuthority, xonlyHex)))
    .orderBy(desc(schema.assets.etchHeight));
}

// Activity ledger for a pubkey: every envelope this pubkey created (as
// asset creator / mint authority) or signed (as the spender, recovered
// from the witness script's first 32-byte push at index time).
//
// SPEC §5 explicitly treats these signatures as publicly attributable —
// CXFER/T_AXFER/T_BURN/T_DEPOSIT/T_PMINT/T_DCLAIM/T_DROP/T_MINT all reveal
// the spender's pubkey in the witness on-chain. We're just indexing what
// the chain already publishes.
export async function getActivityByPubkey(network: string, xonlyHex: string, limit = 200) {
  return db.execute<{
    txid: string;
    opcode: string;
    asset_id: string | null;
    ticker: string | null;
    role: string; // 'created' | 'mint_authority' | 'signer'
    block_height: number | null;
    block_time: Date | null;
    chain_status: string;
    first_seen_at: Date;
    status: string;
  }>(sql`
    WITH role_union AS (
      -- Assets where this pubkey is the creator (CETCH / T_PETCH author)
      SELECT a.etch_txid AS txid, 'created'::text AS role
      FROM assets a
      WHERE a.network = ${network} AND a.creator_pubkey = ${xonlyHex}
      UNION
      -- Assets where this pubkey is the mint authority (issuer) — surface
      -- the CETCH etch tx itself so the timeline shows "this is your
      -- mintable asset", not just mint events.
      SELECT a.etch_txid AS txid, 'mint_authority'::text AS role
      FROM assets a
      WHERE a.network = ${network} AND a.mint_authority = ${xonlyHex}
      UNION
      -- Every envelope signed by this pubkey (spends — CXFER/T_BURN/etc.,
      -- plus T_MINT issuer-signed which also lands here)
      SELECT e.txid, 'signer'::text AS role
      FROM envelopes e
      WHERE e.network = ${network} AND e.spending_pubkey = ${xonlyHex}
    )
    SELECT
      e.txid,
      e.opcode,
      e.asset_id,
      a.ticker,
      r.role,
      e.block_height,
      e.block_time,
      e.chain_status,
      e.first_seen_at,
      e.status
    FROM role_union r
    JOIN envelopes e ON e.txid = r.txid
    LEFT JOIN assets a ON a.asset_id = e.asset_id
    WHERE e.chain_status <> 'orphaned'
    ORDER BY (e.chain_status = 'mempool') DESC, e.block_height DESC NULLS FIRST, e.first_seen_at DESC
    LIMIT ${limit}
  `);
}

// Distinct assets a pubkey has touched (created, issued, or transacted
// against). One row per asset with an aggregated role label so the Tokens
// tab can show "creator / issuer / signer" at a glance.
export async function getTokensByPubkey(network: string, xonlyHex: string) {
  return db.execute<{
    asset_id: string;
    ticker: string;
    kind: string;
    image_uri: string | null;
    resolved_image_url: string | null;
    etch_height: number;
    etch_block_time: Date;
    is_creator: boolean;
    is_mint_authority: boolean;
    is_signer: boolean;
    last_block_height: number | null;
  }>(sql`
    WITH touched AS (
      SELECT a.asset_id, true AS is_creator, false AS is_mint_authority, false AS is_signer, a.etch_height AS h
      FROM assets a
      WHERE a.network = ${network} AND a.creator_pubkey = ${xonlyHex}
      UNION ALL
      SELECT a.asset_id, false, true, false, a.etch_height
      FROM assets a
      WHERE a.network = ${network} AND a.mint_authority = ${xonlyHex}
      UNION ALL
      SELECT e.asset_id, false, false, true, e.block_height
      FROM envelopes e
      WHERE e.network = ${network} AND e.spending_pubkey = ${xonlyHex} AND e.asset_id IS NOT NULL
    )
    SELECT
      a.asset_id,
      a.ticker,
      a.kind,
      a.image_uri,
      a.resolved_image_url,
      a.etch_height,
      a.etch_block_time,
      bool_or(t.is_creator) AS is_creator,
      bool_or(t.is_mint_authority) AS is_mint_authority,
      bool_or(t.is_signer) AS is_signer,
      MAX(t.h) AS last_block_height
    FROM touched t
    JOIN assets a ON a.asset_id = t.asset_id
    WHERE a.network = ${network}
    GROUP BY a.asset_id, a.ticker, a.kind, a.image_uri, a.resolved_image_url, a.etch_height, a.etch_block_time
    ORDER BY last_block_height DESC NULLS LAST, a.etch_height DESC
  `);
}

// Tacit txs the address appeared in (as input prevout or output). NOT a
// claim of asset ownership — see schema.ts notes on tx_addresses.
export async function getAddressInteractions(network: string, address: string, limit = 100) {
  return db.execute<{
    txid: string;
    role: string;
    opcode: string;
    asset_id: string | null;
    ticker: string | null;
    block_height: number | null;
    block_time: Date | null;
    chain_status: string;
    first_seen_at: Date;
  }>(sql`
    SELECT
      ta.txid,
      ta.role,
      e.opcode,
      e.asset_id,
      a.ticker,
      e.block_height,
      e.block_time,
      e.chain_status,
      e.first_seen_at
    FROM tx_addresses ta
    JOIN envelopes e ON e.txid = ta.txid
    LEFT JOIN assets a ON a.asset_id = e.asset_id
    WHERE ta.network = ${network}
      AND ta.address = ${address}
      AND e.chain_status <> 'orphaned'
    ORDER BY (e.chain_status = 'mempool') DESC, e.block_height DESC NULLS FIRST, e.first_seen_at DESC
    LIMIT ${limit}
  `);
}

export async function getCommitmentsByTx(txid: string) {
  return db.select().from(schema.commitments).where(and(eq(schema.commitments.network, NETWORK), eq(schema.commitments.txid, txid)));
}

export async function getCommitment(txid: string, vout: number) {
  const rows = await db
    .select({
      c: schema.commitments,
      asset: schema.assets,
      env: schema.envelopes,
    })
    .from(schema.commitments)
    .leftJoin(schema.assets, eq(schema.commitments.assetId, schema.assets.assetId))
    .leftJoin(schema.envelopes, eq(schema.commitments.txid, schema.envelopes.txid))
    .where(and(and(eq(schema.commitments.network, NETWORK), eq(schema.commitments.txid, txid)), eq(schema.commitments.vout, vout)))
    .limit(1);
  return rows[0] ?? null;
}

// Search: txid prefix → envelope, asset_id prefix → asset, ticker substring → assets.
export async function search(q: string) {
  const norm = q.trim().toLowerCase();
  if (!norm) return { txids: [], assets: [] };

  const looksLikeHex = /^[0-9a-f]+$/.test(norm);
  const txids = looksLikeHex && norm.length >= 4
    ? await db
        .select({
          txid: schema.envelopes.txid,
          opcode: schema.envelopes.opcode,
          blockHeight: schema.envelopes.blockHeight,
        })
        .from(schema.envelopes)
        .where(and(eq(schema.envelopes.network, NETWORK), sql`${schema.envelopes.txid} LIKE ${norm + "%"}`))
        .limit(5)
    : [];

  const idAssets = looksLikeHex && norm.length >= 4
    ? await db
        .select({
          assetId: schema.assets.assetId,
          ticker: schema.assets.ticker,
          kind: schema.assets.kind,
        })
        .from(schema.assets)
        .where(and(eq(schema.assets.network, NETWORK), sql`${schema.assets.assetId} LIKE ${norm + "%"}`))
        .limit(5)
    : [];

  const tickerAssets = await db
    .select({
      assetId: schema.assets.assetId,
      ticker: schema.assets.ticker,
      kind: schema.assets.kind,
    })
    .from(schema.assets)
    .where(and(eq(schema.assets.network, NETWORK), ilike(schema.assets.ticker, `%${q}%`)))
    .limit(8);

  // Dedupe assets by id, prefer ticker matches first.
  const seen = new Set<string>();
  const assets = [...tickerAssets, ...idAssets].filter((a) => {
    if (seen.has(a.assetId)) return false;
    seen.add(a.assetId);
    return true;
  });

  return { txids, assets };
}

export async function getCursor(network: string) {
  const rows = await db.select().from(schema.cursor).where(eq(schema.cursor.network, network)).limit(1);
  return rows[0] ?? null;
}

export interface BlockRow {
  height: number;
  blockHash: string;
  blockTime: Date;
  envelopeCount: number;
}

// Recent blocks the indexer has walked, newest first, each tagged with
// the count of confirmed Tacit envelopes that landed in it. Blocks with
// zero envelopes are still listed — the indexer records every walked
// block. Mempool envelopes are excluded since they have no block_height.
export async function getRecentBlocks(network: string, limit = 10): Promise<BlockRow[]> {
  const rows = await db.execute<{
    height: number;
    block_hash: string;
    block_time: Date;
    envelope_count: number;
  }>(sql`
    SELECT
      b.height,
      b.block_hash,
      b.block_time,
      COALESCE(ec.cnt, 0)::int AS envelope_count
    FROM (SELECT height,block_hash,block_time FROM blocks
      WHERE network=${network} ORDER BY height DESC LIMIT ${limit}) b
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM envelopes
      WHERE network=${network} AND chain_status='confirmed' AND block_height=b.height
    ) ec ON true ORDER BY b.height DESC
  `);
  return rows.map((r) => ({
    height: r.height,
    blockHash: r.block_hash,
    blockTime: new Date(r.block_time),
    envelopeCount: r.envelope_count,
  }));
}

export async function getBlocksPage(network: string, opts: { limit?: number; offset?: number } = {}): Promise<BlockRow[]> {
  const { limit = 50, offset = 0 } = opts;
  const rows = await db.execute<{
    height: number;
    block_hash: string;
    block_time: Date;
    envelope_count: number;
  }>(sql`
    SELECT
      b.height,
      b.block_hash,
      b.block_time,
      COALESCE(ec.cnt, 0)::int AS envelope_count
    FROM (SELECT height,block_hash,block_time FROM blocks
      WHERE network=${network} ORDER BY height DESC LIMIT ${limit} OFFSET ${offset}) b
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM envelopes
      WHERE network=${network} AND chain_status='confirmed' AND block_height=b.height
    ) ec ON true ORDER BY b.height DESC
  `);
  return rows.map((r) => ({
    height: r.height,
    blockHash: r.block_hash,
    blockTime: new Date(r.block_time),
    envelopeCount: r.envelope_count,
  }));
}

export async function getBlocksCount(network: string): Promise<number> {
  const rows = await db.execute<{ c: number }>(
    sql`SELECT COUNT(*)::int AS c FROM blocks WHERE network = ${network}`,
  );
  return rows[0]?.c ?? 0;
}

// Set of tickers that have more than one asset registered against them.
// Caller can quickly check `dups.has(ticker)` to decide whether to render
// `TICKER` or `TICKER#fragment`.
export async function getDuplicateTickers(network: string): Promise<Set<string>> {
  return cached(`duplicate-tickers:${network}`, 30000, async () => {
  const rows = await db.execute<{ ticker: string }>(sql`
    SELECT ticker FROM assets
    WHERE network = ${network}
    GROUP BY ticker
    HAVING COUNT(*) > 1
  `);
  return new Set(rows.map((r) => r.ticker));
  });
}
