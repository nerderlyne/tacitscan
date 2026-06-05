// One-shot backfill: re-decode envelopes that were stored as opcode=UNKNOWN
// because they used an opcode this indexer didn't recognize at the time
// they were ingested. Runs on indexer startup (same pattern as the
// spending_pubkey backfill).
//
// Why this exists: per SPEC §5 forward-compat rule, the indexer correctly
// records unrecognized opcodes as UNKNOWN/no-op rather than crashing.
// When we later add a decoder for one of those bytes (e.g. T_DROP/0x2b,
// T_DCLAIM/0x2c, T_AXFER_VAR/0x37), historical rows would stay UNKNOWN
// forever unless we re-scan. This backfill closes that gap idempotently.
//
// Idempotent: filters on `opcode = 'UNKNOWN' AND decode_error LIKE
// 'unknown opcode 0x%'`. After the first successful re-decode the row's
// opcode/status flip and it no longer matches.

import { db, schema } from "./db.js";
import { sql, eq } from "drizzle-orm";
import { decodePayload, bytesToHex, type DecodedEnvelope } from "./envelope.js";

const BATCH = 200;

export async function backfillRedecode(): Promise<void> {
  let processed = 0;
  let updated = 0;
  for (;;) {
    const rows = await db
      .select({
        txid: schema.envelopes.txid,
        rawPayload: schema.envelopes.rawPayload,
      })
      .from(schema.envelopes)
      .where(
        sql`${schema.envelopes.opcode} = 'UNKNOWN'
            AND ${schema.envelopes.decodeError} LIKE 'unknown opcode 0x%'`,
      )
      .limit(BATCH);
    if (rows.length === 0) break;

    let progressed = false;
    for (const row of rows) {
      processed++;
      const result = decodePayload(row.rawPayload);
      if (!result.ok) {
        // Decoder still doesn't recognize this opcode — leave the row as
        // UNKNOWN but update decode_error if it changed (it shouldn't,
        // but defensive against decoder evolution).
        await db
          .update(schema.envelopes)
          .set({ decodeError: result.reason })
          .where(eq(schema.envelopes.txid, row.txid));
        continue;
      }
      const env = result.envelope;
      const update = buildUpdateSet(env);
      if (!update) continue;
      await db
        .update(schema.envelopes)
        .set(update)
        .where(eq(schema.envelopes.txid, row.txid));
      updated++;
      progressed = true;
    }
    if (!progressed) break; // nothing more we can flip; remaining rows are still genuinely unknown
  }
  if (processed > 0) {
    console.log(`[backfill-redecode] processed ${processed}, updated ${updated}`);
  }
}

// Per-opcode column mapping. Mirrors handlers.ts persistence but produces
// an UPDATE SET payload rather than an INSERT. Returns null for opcodes
// whose backfill isn't worth supporting (e.g. ones that require
// transaction-level state like commitments writes).
function buildUpdateSet(env: DecodedEnvelope): Partial<typeof schema.envelopes.$inferInsert> | null {
  const base = {
    opcode: env.opcode,
    status: "ok" as const,
    decodeError: null,
  };
  switch (env.opcode) {
    case "T_DROP":
      if (env.isReclaim) {
        return {
          ...base,
          assetId: env.assetId,
          publicAmount: env.capAmount,
          burnedAmount: 0n,
          etchTxid: env.reclaimDropId,
        };
      }
      return {
        ...base,
        assetId: env.assetId,
        publicAmount: env.capAmount,
        burnedAmount: env.perClaim,
        merkleRoot: bytesToHex(env.merkleRoot),
        assetInputCount: env.assetInputCount,
        kernelSig: env.kernelSig,
      };
    case "T_DCLAIM":
      return {
        ...base,
        assetId: env.assetId,
        etchTxid: env.dropRevealTxid,
        publicAmount: env.amount,
        n: 1,
      };
    case "T_AXFER_VAR":
      return {
        ...base,
        assetId: env.assetId,
        n: env.n,
        assetInputCount: env.assetInputCount,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
      };
    case "T_CXFER_BPP":
      return {
        ...base,
        assetId: env.assetId,
        n: env.n,
        kernelSig: env.kernelSig,
        rangeproof: env.rangeproof,
      };
    case "T_WRAPPER_ATTEST":
      return {
        ...base,
        assetId: env.assetId,
        issuerSig: env.attestationSig,
      };
    case "T_SLOT_MINT":
      return {
        ...base,
        assetId: env.assetId,
        denomination: env.denomSats,
        publicAmount: env.paymentAmount,
        n: 1,
      };
    case "T_SLOT_BURN":
      return {
        ...base,
        assetId: env.assetId,
        denomination: env.denomSats,
        merkleRoot: bytesToHex(env.merkleRoot),
        nullifierHash: bytesToHex(env.nullifierHash),
        proofBytes: env.proof,
      };
    case "T_SLOT_ROTATE":
      return {
        ...base,
        assetId: env.assetId,
        denomination: env.denomSats,
        merkleRoot: bytesToHex(env.oldMerkleRoot),
        nullifierHash: bytesToHex(env.oldNullifierHash),
        proofBytes: env.oldProof,
        publicAmount: env.paymentAmount,
        n: 1,
      };
    case "T_SLOT_SPLIT":
      return {
        ...base,
        assetId: env.assetIdOld,
        denomination: env.denomOld,
        merkleRoot: bytesToHex(env.oldMerkleRoot),
        nullifierHash: bytesToHex(env.oldNullifierHash),
        proofBytes: env.oldProof,
        n: env.outputs.length,
      };
    case "T_SLOT_MERGE":
      return {
        ...base,
        assetId: env.assetIdNew,
        denomination: env.denomNew,
        assetInputCount: env.inputs.length,
        n: 1,
      };
    case "T_CBTC_TAC_DEPOSIT":
      return {
        ...base,
        merkleRoot: bytesToHex(env.targetLeafHash),
        denomination: env.slotDenomSats,
        publicAmount: env.mintAmount,
        proofBytes: env.proof,
        n: 1,
      };
    case "T_CBTC_TAC_FORCE_CLOSE":
      return {
        ...base,
        merkleRoot: bytesToHex(env.targetLeafHash),
      };
    case "T_CTAC_LIEN_SPLIT":
      return {
        ...base,
        merkleRoot: bytesToHex(env.positionLeafHash),
        n: env.outputs.length,
      };
    case "T_BRIDGE_DEPOSIT":
      return {
        ...base,
        assetId: env.assetId,
        denomWei: env.denomWei.toString(),
        merkleRoot: bytesToHex(env.ethRoot),
        nullifierHash: bytesToHex(env.nullifierHash),
        proofBytes: env.proof,
        n: 1,
      };
    case "T_BRIDGE_BURN":
      return {
        ...base,
        assetId: env.assetId,
        denomWei: env.denomWei.toString(),
        merkleRoot: bytesToHex(env.merkleRoot),
        nullifierHash: bytesToHex(env.nullifierHash),
        ethRecipient: bytesToHex(env.ethRecipient),
        proofBytes: env.proof,
      };
    case "T_BRIDGE_ROTATE":
      return {
        ...base,
        assetId: env.assetId,
        denomWei: env.denomWei.toString(),
        merkleRoot: bytesToHex(env.merkleRoot),
        nullifierHash: bytesToHex(env.nullifierHash),
        proofBytes: env.oldProof,
        n: 1,
      };
    case "T_BRIDGE_NOTE":
      return { ...base };
    // The originally-shipped opcodes shouldn't appear in this backfill
    // (they were already recognized when the envelope was ingested), but
    // be defensive in case of future shifts: skip rather than partially
    // re-persist without their commitment-table sibling rows.
    default:
      return null;
  }
}
