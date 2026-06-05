// Per-opcode persistence. Each handler takes a decoded envelope + tx
// context and writes rows to Postgres. Idempotent via primary keys —
// safe to re-run on the same block.
import type { DB } from "./db.js";
import { schema } from "./db.js";
import {
  bytesToHex,
  deriveAssetId,
  type DecodedEnvelope,
  type DecodeResult,
} from "./envelope.js";
import { extractSpendingPubkey } from "./script.js";
import type { EsploraTx } from "./esplora.js";

export interface BlockCtx {
  network: string;
  height: number;
  blockHash: string;
  blockTime: Date;
}

export interface TxCtx extends BlockCtx {
  txid: string;
  txIndex: number;
  inputCount: number;
  outputCount: number;
  feeSats: bigint | null;
}

// Promotion-set for ON CONFLICT (txid) DO UPDATE when a confirmed block
// includes a tx we already had as 'mempool' (or 'orphaned' from a prior
// reorg). Block fields become authoritative; raw_* / decoded fields are
// trusted from the earlier insert since the envelope can't change without
// the txid changing.
function envelopeConfirmSet(ctx: TxCtx) {
  return {
    blockHeight: ctx.height,
    blockHash: ctx.blockHash,
    blockTime: ctx.blockTime,
    txIndex: ctx.txIndex,
    chainStatus: "confirmed" as const,
  };
}

export async function persistEnvelope(
  db: DB,
  tx: EsploraTx,
  ctx: TxCtx,
  result: DecodeResult,
  rawWitness: Uint8Array,
): Promise<void> {
  // SPEC §5: every Tacit envelope-bearing input has the canonical leaf-script
  // shape `<32B pubkey> OP_CHECKSIG OP_FALSE OP_IF ...`. The pubkey is the
  // holder's tacit_pubkey — what verifies the spend. We surface this in the
  // address-page Activity tab. Null for shape-malformed witnesses.
  const spendingPubkey = extractSpendingPubkey(rawWitness);

  // The commit tx that funded this envelope. Tacit envelopes ride in a
  // P2TR script-path spend at vin[0], so its prior txid IS the commit half.
  // Stored so /tx/<commit_txid> can resolve back to this envelope row —
  // the commit tx has no envelope of its own and would otherwise 404.
  const commitTxid = tx.vin[0]?.txid ?? null;

  // Malformed / unknown envelope — record minimal row so the explorer can
  // still surface the tx.
  if (!result.ok) {
    await db
      .insert(schema.envelopes)
      .values({
        txid: ctx.txid,
        network: ctx.network,
        opcode: "UNKNOWN",
        blockHeight: ctx.height,
        blockHash: ctx.blockHash,
        blockTime: ctx.blockTime,
        txIndex: ctx.txIndex,
        inputCount: ctx.inputCount,
        outputCount: ctx.outputCount,
        feeSats: ctx.feeSats,
        rawWitness,
        rawPayload: result.rawPayload ?? new Uint8Array(0),
        status: "malformed",
        decodeError: result.reason,
        spendingPubkey,
        commitTxid,
      })
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    return;
  }

  const env = result.envelope;
  const base = {
    txid: ctx.txid,
    network: ctx.network,
    opcode: env.opcode,
    blockHeight: ctx.height,
    blockHash: ctx.blockHash,
    blockTime: ctx.blockTime,
    txIndex: ctx.txIndex,
    inputCount: ctx.inputCount,
    outputCount: ctx.outputCount,
    feeSats: ctx.feeSats,
    rawWitness,
    rawPayload: result.rawPayload,
    status: "ok",
    spendingPubkey,
    commitTxid,
  } as const;

  switch (env.opcode) {
    case "CETCH":
      return persistCetch(db, env, ctx, base);
    case "T_PETCH":
      return persistTPetch(db, env, ctx, base);
    case "T_MINT":
      return persistTMint(db, env, ctx, base);
    case "T_PMINT":
      return persistTPmint(db, env, ctx, base);
    case "CXFER":
      return persistCxfer(db, env, ctx, base);
    case "T_AXFER":
      return persistTAxfer(db, env, ctx, base);
    case "T_BURN":
      return persistTBurn(db, env, ctx, base);
    case "T_DEPOSIT":
      return persistTDeposit(db, env, ctx, base);
    case "T_WITHDRAW":
      return persistTWithdraw(db, env, ctx, base);
    case "T_DROP":
      return persistTDrop(db, env, ctx, base);
    case "T_DCLAIM":
      return persistTDclaim(db, env, ctx, base);
    case "T_AXFER_VAR":
      return persistTAxferVar(db, env, ctx, base);
    case "T_CXFER_BPP":
      return persistTCxferBpp(db, env, ctx, base);
    case "T_WRAPPER_ATTEST":
      return persistTWrapperAttest(db, env, ctx, base);
    case "T_SLOT_MINT":
      return persistTSlotMint(db, env, ctx, base);
    case "T_SLOT_BURN":
      return persistTSlotBurn(db, env, ctx, base);
    case "T_SLOT_ROTATE":
      return persistTSlotRotate(db, env, ctx, base);
    case "T_SLOT_SPLIT":
      return persistTSlotSplit(db, env, ctx, base);
    case "T_SLOT_MERGE":
      return persistTSlotMerge(db, env, ctx, base);
    case "T_CBTC_TAC_DEPOSIT":
      return persistTCbtcTacDeposit(db, env, ctx, base);
    case "T_CBTC_TAC_FORCE_CLOSE":
      return persistTCbtcTacForceClose(db, env, ctx, base);
    case "T_CTAC_LIEN_SPLIT":
      return persistTCtacLienSplit(db, env, ctx, base);
    case "T_BRIDGE_DEPOSIT":
      return persistTBridgeDeposit(db, env, ctx, base);
    case "T_BRIDGE_BURN":
      return persistTBridgeBurn(db, env, ctx, base);
    case "T_BRIDGE_ROTATE":
      return persistTBridgeRotate(db, env, ctx, base);
    case "T_BRIDGE_NOTE":
      return persistTBridgeNote(db, env, ctx, base);
  }
}

async function persistCetch(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "CETCH" }>,
  ctx: TxCtx,
  base: object,
) {
  const assetId = deriveAssetId(ctx.txid, 0);
  const isMintable = !env.mintAuthority.every((b) => b === 0);
  await db.transaction(async (t) => {
    await t
      .insert(schema.assets)
      .values({
        assetId,
        network: ctx.network,
        kind: "cetch",
        ticker: env.ticker,
        decimals: env.decimals,
        imageUri: env.imageUri || null,
        mintAuthority: isMintable ? bytesToHex(env.mintAuthority) : null,
        etchTxid: ctx.txid,
        etchHeight: ctx.height,
        etchBlockTime: ctx.blockTime,
      })
      .onConflictDoNothing();
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId,
        rangeproof: env.rangeproof,
        n: 1,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId,
        commitmentC: env.commitmentC,
        encryptedAmount: env.amountCt,
        blockHeight: ctx.height,
      })
      .onConflictDoNothing();
  });
}

async function persistTPetch(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_PETCH" }>,
  ctx: TxCtx,
  base: object,
) {
  const assetId = deriveAssetId(ctx.txid, 0);

  // SPEC §5.8 invariants enforced at indexing time:
  //   mint_start_height (if non-zero) MUST be ≥ etch_height + 1
  //     — defends the "zero deployer allocation" property by preventing
  //       same-block deployer pre-mining.
  //   mint_end_height (if non-zero) MUST be > effective_start
  //     — otherwise the window is empty and the asset can never mint.
  // A T_PETCH violating either is permanently invalid; we record the
  // envelope as malformed and skip the assets-table insert so the bad
  // T_PETCH never enters the registry.
  const effectiveStart = env.mintStartHeight !== 0 ? env.mintStartHeight : ctx.height + 1;
  let invalidReason: string | null = null;
  if (env.mintStartHeight !== 0 && env.mintStartHeight < ctx.height + 1) {
    invalidReason = `mint_start_height ${env.mintStartHeight} < etch_height+1 (${ctx.height + 1})`;
  } else if (env.mintEndHeight !== 0 && env.mintEndHeight <= effectiveStart) {
    invalidReason = `mint_end_height ${env.mintEndHeight} <= effective_start ${effectiveStart}`;
  }

  if (invalidReason) {
    await db
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId,
        status: "malformed",
        decodeError: invalidReason,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    return;
  }

  await db.transaction(async (t) => {
    await t
      .insert(schema.assets)
      .values({
        assetId,
        network: ctx.network,
        kind: "t_petch",
        ticker: env.ticker,
        decimals: env.decimals,
        imageUri: env.imageUri || null,
        capAmount: env.capAmount,
        mintLimit: env.mintLimit,
        mintStartHeight: env.mintStartHeight,
        mintEndHeight: env.mintEndHeight,
        etchTxid: ctx.txid,
        etchHeight: ctx.height,
        etchBlockTime: ctx.blockTime,
      })
      .onConflictDoNothing();
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    // T_PETCH produces NO tacit UTXO — no commitment row.
  });
}

async function persistTMint(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_MINT" }>,
  ctx: TxCtx,
  base: object,
) {
  const expected = deriveAssetId(env.etchTxid, 0);
  const ok = expected === env.assetId;
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        etchTxid: env.etchTxid,
        rangeproof: env.rangeproof,
        issuerSig: env.issuerSig,
        n: 1,
        status: ok ? "ok" : "malformed",
        decodeError: ok ? null : "asset_id != sha256(etch_txid || 0)",
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId: env.assetId,
        commitmentC: env.commitmentC,
        encryptedAmount: env.amountCt,
        blockHeight: ctx.height,
      })
      .onConflictDoNothing();
  });
}

async function persistTPmint(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_PMINT" }>,
  ctx: TxCtx,
  base: object,
) {
  const expected = deriveAssetId(env.etchTxid, 0);
  const ok = expected === env.assetId;
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        etchTxid: env.etchTxid,
        publicAmount: env.amount,
        n: 1,
        status: ok ? "ok" : "malformed",
        decodeError: ok ? null : "asset_id != sha256(etch_txid || 0)",
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId: env.assetId,
        commitmentC: env.commitmentC,
        encryptedAmount: null,
        blockHeight: ctx.height,
        isPublicOpening: true,
        publicAmount: env.amount,
        publicBlinding: env.blinding,
      })
      .onConflictDoNothing();
  });
}

async function persistCxfer(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "CXFER" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
        n: env.n,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    if (env.outputs.length > 0) {
      await t
        .insert(schema.commitments)
        .values(
          env.outputs.map((o) => ({
            txid: ctx.txid,
            vout: o.vout,
            network: ctx.network,
            assetId: env.assetId,
            commitmentC: o.commitmentC,
            encryptedAmount: o.encryptedAmount,
            blockHeight: ctx.height,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

async function persistTAxfer(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_AXFER" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
        n: env.n,
        assetInputCount: env.assetInputCount,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    if (env.outputs.length > 0) {
      await t
        .insert(schema.commitments)
        .values(
          env.outputs.map((o) => ({
            txid: ctx.txid,
            vout: o.vout,
            network: ctx.network,
            assetId: env.assetId,
            commitmentC: o.commitmentC,
            encryptedAmount: o.encryptedAmount,
            blockHeight: ctx.height,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

async function persistTBurn(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_BURN" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
        burnedAmount: env.burnedAmount,
        publicAmount: env.burnedAmount,
        n: env.n,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    if (env.outputs.length > 0) {
      await t
        .insert(schema.commitments)
        .values(
          env.outputs.map((o) => ({
            txid: ctx.txid,
            vout: o.vout,
            network: ctx.network,
            assetId: env.assetId,
            commitmentC: o.commitmentC,
            encryptedAmount: o.encryptedAmount,
            blockHeight: ctx.height,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

async function persistTDeposit(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_DEPOSIT" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomination: env.isPoolInit ? env.poolDenom : env.denomination,
      kernelSig: env.isPoolInit ? null : env.kernelSig,
      issuerSig: env.isPoolInit ? env.initSig : null,
      isPoolInit: env.isPoolInit,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
  // T_DEPOSIT produces no tacit UTXO.
}

async function persistTWithdraw(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_WITHDRAW" }>,
  ctx: TxCtx,
  base: object,
) {
  await db.transaction(async (t) => {
    await t
      .insert(schema.envelopes)
      .values({
        ...(base as object),
        assetId: env.assetId,
        denomination: env.denomination,
        publicAmount: env.denomination,
        merkleRoot: bytesToHex(env.merkleRoot),
        nullifierHash: bytesToHex(env.nullifierHash),
        proofBytes: env.proof,
        n: 1,
      } as typeof schema.envelopes.$inferInsert)
      .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
    await t
      .insert(schema.commitments)
      .values({
        txid: ctx.txid,
        vout: 0,
        network: ctx.network,
        assetId: env.assetId,
        commitmentC: env.recipientCommitment,
        encryptedAmount: null,
        blockHeight: ctx.height,
        isPublicOpening: true,
        publicAmount: env.denomination,
      })
      .onConflictDoNothing();
  });
}

// SPEC §5.12: T_DROP — supply-locking deposit into a public-claim pool.
// Skeleton persistence: record opcode + asset_id + key scalars so the UI
// can show the event in context. Sig / merkle / per-input-commitment
// validation is deferred (we don't validate Schnorr today on T_DROP).
//
// Two shapes share the row layout:
//   standard:  public_amount = cap_amount, burned_amount = per_claim,
//              merkle_root, asset_input_count, kernel_sig
//   reclaim:   public_amount = cap_amount, burned_amount = 0 (sentinel),
//              etch_txid = reclaim_drop_id (parent reference)
// The shape is recoverable from the row by checking burned_amount == 0
// (reclaim) vs > 0 (standard); the raw_payload is also stored verbatim
// for any future need.
async function persistTDrop(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_DROP" }>,
  ctx: TxCtx,
  base: object,
) {
  const shared = {
    ...(base as object),
    assetId: env.assetId,
    publicAmount: env.capAmount,
  };
  const shapeFields = env.isReclaim
    ? {
        burnedAmount: 0n,
        etchTxid: env.reclaimDropId,
      }
    : {
        burnedAmount: env.perClaim,
        merkleRoot: bytesToHex(env.merkleRoot),
        assetInputCount: env.assetInputCount,
        kernelSig: env.kernelSig,
      };
  await db
    .insert(schema.envelopes)
    .values({ ...shared, ...shapeFields } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
  // T_DROP (standard) produces no tacit UTXO at vout[0]; reclaim does, but
  // we defer the commitment-table insert until a future commitment audit
  // pass — skeleton is just envelope-row visibility.
}

// SPEC §5.13: T_DCLAIM — permissionless claim event.
// Skeleton persistence: opcode + asset_id + parent drop_reveal_txid +
// public amount. The commitment opens to (amount, blinding) — public —
// but we don't insert into commitments yet since the validator path for
// these isn't in place.
async function persistTDclaim(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_DCLAIM" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      etchTxid: env.dropRevealTxid, // re-use etch_txid as the "parent envelope" slot, same as T_PMINT
      publicAmount: env.amount,
      n: 1, // T_DCLAIM produces a single recipient UTXO at vout[0]
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC §5.7.9: T_AXFER_VAR — variable-amount atomic settlement.
// Skeleton persistence: opcode + asset_id + n=2 + asset_input_count=1 +
// rangeproof bytes + kernel sig. Vout layout is interleaved (tacit at
// {0,2}, BTC payment at 1, OP_RETURN at 3); commitments aren't indexed
// into the per-output table yet.
async function persistTAxferVar(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_AXFER_VAR" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      n: env.n,
      assetInputCount: env.assetInputCount,
      kernelSig: env.kernelSig,
      rangeproof: env.rangeproof,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC §5.21: T_CXFER_BPP — wire-identical to CXFER modulo opcode + BP+ rangeproof.
// Skeleton persistence: asset_id + n + kernel_sig + rangeproof. Same layout
// as persistCxfer for the envelope row; commitment-table inserts deferred
// like the other skeleton-decoded opcodes.
async function persistTCxferBpp(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_CXFER_BPP" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      n: env.n,
      kernelSig: env.kernelSig,
      rangeproof: env.rangeproof,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC §5.19: T_WRAPPER_ATTEST — signed wrapper-issuer attestation.
// Skeleton persistence: asset_id + issuer_sig. The (reserves, supply,
// as_of_height) tuple isn't stored as scalars yet; raw_payload preserves
// it for a future wrapper-attestation log table.
async function persistTWrapperAttest(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_WRAPPER_ATTEST" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      issuerSig: env.attestationSig,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-ZK §5.21: T_SLOT_MINT — atomic cBTC.zk slot mint.
// Skeleton persistence: asset_id (wrapper) + denomination (slot size) +
// public_amount (LP's payment in payment_asset).
async function persistTSlotMint(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_SLOT_MINT" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomination: env.denomSats,
      publicAmount: env.paymentAmount,
      n: 1,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-ZK §5.22: T_SLOT_BURN — atomic slot redeem.
// Skeleton persistence: asset_id + denomination + merkle_root + nullifier_hash + proof.
async function persistTSlotBurn(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_SLOT_BURN" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomination: env.denomSats,
      merkleRoot: bytesToHex(env.merkleRoot),
      nullifierHash: bytesToHex(env.nullifierHash),
      proofBytes: env.proof,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-ZK §5.23: T_SLOT_ROTATE — atomic transfer / key rotation.
// Skeleton persistence: asset_id + denomination + old nullifier + Groth16 proof.
async function persistTSlotRotate(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_SLOT_ROTATE" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomination: env.denomSats,
      merkleRoot: bytesToHex(env.oldMerkleRoot),
      nullifierHash: bytesToHex(env.oldNullifierHash),
      proofBytes: env.oldProof,
      publicAmount: env.paymentAmount, // 0 if no payment
      n: 1,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-ZK-FUNGIBILITY §5.24: T_SLOT_SPLIT — atomic 1→N split.
// Skeleton: asset_id = old (most-stable single-row id), n = output count,
// denomination = old denom, nullifier = old.
async function persistTSlotSplit(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_SLOT_SPLIT" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetIdOld,
      denomination: env.denomOld,
      merkleRoot: bytesToHex(env.oldMerkleRoot),
      nullifierHash: bytesToHex(env.oldNullifierHash),
      proofBytes: env.oldProof,
      n: env.outputs.length,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-ZK-FUNGIBILITY §5.25: T_SLOT_MERGE — atomic N→1 merge.
// Skeleton: asset_id = new (the merged result), assetInputCount = n_inputs,
// denomination = new denom, n = 1 (single output slot).
async function persistTSlotMerge(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_SLOT_MERGE" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetIdNew,
      denomination: env.denomNew,
      assetInputCount: env.inputs.length,
      n: 1,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-TAC §5.36: T_CBTC_TAC_DEPOSIT — LP-share lien mint.
// Skeleton: target_leaf_hash stored in merkle_root (closest semantic fit —
// a "reference" hash field that's not strictly a merkle root but
// distinguishable by opcode). public_amount = mint_amount.
async function persistTCbtcTacDeposit(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_CBTC_TAC_DEPOSIT" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      merkleRoot: bytesToHex(env.targetLeafHash),
      denomination: env.slotDenomSats,
      publicAmount: env.mintAmount,
      proofBytes: env.proof,
      n: 1,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-TAC §5.38: T_CBTC_TAC_FORCE_CLOSE — permissionless liquidation.
// Skeleton: target_leaf_hash in merkle_root, no asset payment.
async function persistTCbtcTacForceClose(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_CBTC_TAC_FORCE_CLOSE" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      merkleRoot: bytesToHex(env.targetLeafHash),
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-CBTC-TAC §5.47.6: T_CTAC_LIEN_SPLIT — split a liened LP-share UTXO.
// Skeleton: position_leaf_hash in merkle_root, n = output count.
async function persistTCtacLienSplit(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_CTAC_LIEN_SPLIT" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      merkleRoot: bytesToHex(env.positionLeafHash),
      n: env.outputs.length,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-TETH-BRIDGE-AMENDMENT §5.60: T_BRIDGE_DEPOSIT — trustless tETH mint.
// Stores eth_root in merkle_root (semantic fit — the cross-chain reference
// root), denom_wei as decimal text (u256), nullifier_hash, and the Groth16
// deposit proof. n=1 (one new leaf appended to the tETH pool).
async function persistTBridgeDeposit(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_BRIDGE_DEPOSIT" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomWei: env.denomWei.toString(),
      merkleRoot: bytesToHex(env.ethRoot),
      nullifierHash: bytesToHex(env.nullifierHash),
      proofBytes: env.proof,
      n: 1,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-TETH-BRIDGE-AMENDMENT §5.61: T_BRIDGE_BURN — trustless tETH → ETH.
// merkle_root is the Tacit-side pool root; eth_recipient holds the 20-byte
// destination address. The burn becomes a proof artifact the user later
// presents to the Ethereum withdraw contract via a BTC inclusion proof.
async function persistTBridgeBurn(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_BRIDGE_BURN" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomWei: env.denomWei.toString(),
      merkleRoot: bytesToHex(env.merkleRoot),
      nullifierHash: bytesToHex(env.nullifierHash),
      ethRecipient: bytesToHex(env.ethRecipient),
      proofBytes: env.proof,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-TETH-BRIDGE-AMENDMENT §5.62: T_BRIDGE_ROTATE — atomic tETH transfer.
// Combines a burn leg (old nullifier + proof) with a mint leg (new leaf)
// bound by sender_sig. Stored shape mirrors T_BRIDGE_BURN minus the
// eth_recipient (the rotate stays on Tacit).
async function persistTBridgeRotate(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_BRIDGE_ROTATE" }>,
  ctx: TxCtx,
  base: object,
) {
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
      assetId: env.assetId,
      denomWei: env.denomWei.toString(),
      merkleRoot: bytesToHex(env.merkleRoot),
      nullifierHash: bytesToHex(env.nullifierHash),
      proofBytes: env.oldProof,
      n: 1,
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}

// SPEC-TETH-BRIDGE-AMENDMENT §5.63: T_BRIDGE_NOTE — encrypted memo.
// Opaque 122-byte payload (ephemeral_pubkey + ciphertext); only the
// recipient's viewing key decrypts. We store the envelope row for
// indexability — the bytes themselves stay in raw_payload.
async function persistTBridgeNote(
  db: DB,
  env: Extract<DecodedEnvelope, { opcode: "T_BRIDGE_NOTE" }>,
  ctx: TxCtx,
  base: object,
) {
  // Touch env so TS doesn't complain about unused destructure target.
  void env;
  await db
    .insert(schema.envelopes)
    .values({
      ...(base as object),
    } as typeof schema.envelopes.$inferInsert)
    .onConflictDoUpdate({ target: schema.envelopes.txid, set: envelopeConfirmSet(ctx) });
}
