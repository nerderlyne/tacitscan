// Drizzle schema for tacitscan.
// SOURCE OF TRUTH. Mirrored to frontend/src/schema.ts — keep in sync.
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
  toDriver(value) {
    return Buffer.from(value);
  },
});

// Per-network indexer cursor.
export const cursor = pgTable("cursor", {
  network: text("network").primaryKey(), // "mainnet" | "signet"
  lastIndexedHeight: integer("last_indexed_height").notNull(),
  lastIndexedBlockHash: text("last_indexed_block_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per asset (CETCH or T_PETCH etch).
export const assets = pgTable(
  "assets",
  {
    assetId: text("asset_id").primaryKey(), // 64 hex chars
    network: text("network").notNull(),
    kind: text("kind").notNull(), // "cetch" | "t_petch"
    ticker: text("ticker").notNull(),
    decimals: integer("decimals").notNull(),
    imageUri: text("image_uri"),
    creatorPubkey: text("creator_pubkey"), // x-only, 64 hex chars
    mintAuthority: text("mint_authority"), // 64 hex chars or null (non-mintable / fair-launch)
    capAmount: bigint("cap_amount", { mode: "bigint" }), // T_PETCH only
    mintLimit: bigint("mint_limit", { mode: "bigint" }), // T_PETCH only
    mintStartHeight: integer("mint_start_height"), // T_PETCH only, 0 = etch_height+1
    mintEndHeight: integer("mint_end_height"), // T_PETCH only, 0 = open
    etchTxid: text("etch_txid").notNull(),
    etchHeight: integer("etch_height").notNull(),
    etchBlockTime: timestamp("etch_block_time", { withTimezone: true }).notNull(),
    // Final resolved image URL, populated by the resolver loop. May be null
    // if image_uri was empty, the fetch failed, or the metadata had no image.
    resolvedImageUrl: text("resolved_image_url"),
    imageResolvedAt: timestamp("image_resolved_at", { withTimezone: true }),
    imageResolveError: text("image_resolve_error"),
  },
  (t) => ({
    tickerIdx: index("assets_ticker_idx").on(t.ticker),
    networkHeightIdx: index("assets_network_height_idx").on(t.network, t.etchHeight),
  }),
);

// One row per envelope (one per Tacit-bearing tx). Stores raw bytes plus
// decoded fields. Verification-heavy fields (rangeproof bytes, kernel sig)
// are stored as bytes so the frontend can show them and a future job can
// batch-verify them.
export const envelopes = pgTable(
  "envelopes",
  {
    txid: text("txid").primaryKey(),
    network: text("network").notNull(),
    opcode: text("opcode").notNull(), // "CETCH" | "CXFER" | "T_MINT" | "T_BURN" | ...
    assetId: text("asset_id"), // null for some shapes (e.g. malformed/unknown)
    // Block fields are NULL while the envelope sits in mempool. Filled in
    // when the block lands. Nulled-out only if a reorg evicts it.
    blockHeight: integer("block_height"),
    blockHash: text("block_hash"),
    blockTime: timestamp("block_time", { withTimezone: true }),
    txIndex: integer("tx_index"), // position within block, for canonical ordering
    // 'mempool' | 'confirmed' | 'orphaned'
    chainStatus: text("chain_status").notNull().default("confirmed"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    inputCount: integer("input_count").notNull(),
    outputCount: integer("output_count").notNull(),
    feeSats: bigint("fee_sats", { mode: "bigint" }),

    // Decoded shape-specific scalars
    burnedAmount: bigint("burned_amount", { mode: "bigint" }), // T_BURN
    publicAmount: bigint("public_amount", { mode: "bigint" }), // T_PMINT (== mint_limit), T_BURN
    n: integer("n"), // count of confidential outputs
    assetInputCount: integer("asset_input_count"), // T_AXFER
    denomination: bigint("denomination", { mode: "bigint" }), // T_DEPOSIT, T_WITHDRAW
    etchTxid: text("etch_txid"), // T_MINT, T_PMINT
    isPoolInit: boolean("is_pool_init").notNull().default(false), // T_DEPOSIT with denom=0

    // Raw bytes
    rawWitness: bytea("raw_witness").notNull(),
    rawPayload: bytea("raw_payload").notNull(),
    kernelSig: bytea("kernel_sig"),
    issuerSig: bytea("issuer_sig"),
    rangeproof: bytea("rangeproof"),
    proofBytes: bytea("proof_bytes"), // Groth16 proof for T_WITHDRAW

    // T_WITHDRAW pool fields
    merkleRoot: text("merkle_root"),
    nullifierHash: text("nullifier_hash"),

    // Decode status. "ok" | "malformed" | "unknown_opcode"
    status: text("status").notNull().default("ok"),
    decodeError: text("decode_error"),

    // x-only pubkey that signed the envelope-bearing input (vin[0]).
    // Extracted from the witness script's first 32-byte push. Powers the
    // address page's per-pubkey activity view. Nullable: very old or
    // shape-malformed witnesses may not have a recoverable spender.
    spendingPubkey: text("spending_pubkey"),

    // The commit tx that funded this envelope's script-path input. Every
    // tacit envelope sits in vin[0]'s witness on a P2TR script-path spend,
    // so the prior tx (vin[0].txid) is its commit half. Stored verbatim so
    // /tx/<commit_txid> can resolve to the same envelope page — the commit
    // half has no envelope of its own and would otherwise 404.
    commitTxid: text("commit_txid"),

    // SPEC-TETH-BRIDGE-AMENDMENT: u256 wei amount (decimal string). Bridge
    // envelopes use 32-byte BE wei values that overflow Postgres BIGINT
    // for pools ≥ 10 ETH (1e20 wei), so we store the decimal string and
    // let the frontend format. Null for non-bridge envelopes.
    denomWei: text("denom_wei"),
    // SPEC-TETH-BRIDGE-AMENDMENT §5.61: 20-byte Ethereum address the
    // ETH-side withdrawal will pay out to (T_BRIDGE_BURN / ROTATE).
    // Stored as 40-char hex string. Null for non-bridge envelopes.
    ethRecipient: text("eth_recipient"),

    // Cryptographic validation result, populated by the validator loop
    // for T_PMINT envelopes. null until checked, true/false after.
    commitmentValid: boolean("commitment_valid"),
    commitmentCheckedAt: timestamp("commitment_checked_at", { withTimezone: true }),
    commitmentInvalidReason: text("commitment_invalid_reason"),
    // BIP-340 Schnorr issuer signature validation for T_MINT envelopes.
    // Verifies the issuer holds the mint_authority key per SPEC §5.3.
    issuerSigValid: boolean("issuer_sig_valid"),
    issuerSigCheckedAt: timestamp("issuer_sig_checked_at", { withTimezone: true }),
    issuerSigInvalidReason: text("issuer_sig_invalid_reason"),
  },
  (t) => ({
    networkHeightIdx: index("envelopes_network_height_idx").on(t.network, t.blockHeight),
    assetIdx: index("envelopes_asset_idx").on(t.assetId, t.blockHeight),
    opcodeIdx: index("envelopes_opcode_idx").on(t.opcode, t.blockHeight),
    blockHeightIdx: index("envelopes_height_desc_idx").on(t.blockHeight),
    chainStatusIdx: index("envelopes_chain_status_idx").on(t.chainStatus, t.network),
    firstSeenIdx: index("envelopes_first_seen_idx").on(t.firstSeenAt),
    spendingPubkeyIdx: index("envelopes_spending_pubkey_idx").on(t.network, t.spendingPubkey, t.blockHeight),
    commitTxidIdx: index("envelopes_commit_txid_idx").on(t.commitTxid),
  }),
);

// Per-block ledger so the reorg walker can compare our recorded hashes
// against canonical chain hashes at each height to find common ancestor.
// Every block we process (with or without envelopes) gets a row.
export const blocks = pgTable(
  "blocks",
  {
    network: text("network").notNull(),
    height: integer("height").notNull(),
    blockHash: text("block_hash").notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.network, t.height] }),
    networkHashIdx: index("blocks_network_hash_idx").on(t.network, t.blockHash),
  }),
);

// One row per (txid, vout) commitment that an envelope produced. CXFER
// produces N=outputs; CETCH/T_MINT/T_PMINT each produce one at vout=0.
export const commitments = pgTable(
  "commitments",
  {
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
    network: text("network").notNull(),
    assetId: text("asset_id").notNull(),
    commitmentC: bytea("commitment_c").notNull(), // 33 bytes compressed
    encryptedAmount: bytea("encrypted_amount"), // 8 bytes; null for fully-public outputs
    blockHeight: integer("block_height").notNull(),
    isPublicOpening: boolean("is_public_opening").notNull().default(false), // true for T_PMINT
    publicAmount: bigint("public_amount", { mode: "bigint" }),
    publicBlinding: bytea("public_blinding"), // T_PMINT publishes blinding
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txid, t.vout] }),
    assetIdx: index("commitments_asset_idx").on(t.assetId, t.blockHeight),
  }),
);

// Voluntary openings published off-chain (§5.6 / disclosures endpoint).
// Empty in v1 unless the user wires up a worker; schema is here so the
// frontend can show "disclosed by holder" if data shows up later.
export const disclosures = pgTable("disclosures", {
  id: text("id").primaryKey(), // sha256(asset_id || owner_pubkey || threshold)
  assetId: text("asset_id").notNull(),
  ownerPubkey: text("owner_pubkey").notNull(),
  threshold: bigint("threshold", { mode: "bigint" }).notNull(),
  utxos: text("utxos").array().notNull(), // ["txid:vout", ...]
  rangeproof: bytea("rangeproof").notNull(),
  sig: bytea("sig").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-tx address index. Populated from confirmed tacit txs only:
// the distinct P2TR addresses found in vin (prevout) and vout. Powers
// the /address page's "interacted with" section. NOT a statement of
// asset ownership (which is confidential).
export const txAddresses = pgTable(
  "tx_addresses",
  {
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    address: text("address").notNull(),
    role: text("role").notNull(), // 'input' | 'output'
  },
  (t) => ({
    pk: primaryKey({ columns: [t.network, t.txid, t.address, t.role] }),
    addrIdx: index("tx_addresses_addr_idx").on(t.address, t.network),
  }),
);

export type Asset = typeof assets.$inferSelect;
export type Envelope = typeof envelopes.$inferSelect;
export type Commitment = typeof commitments.$inferSelect;
export type Disclosure = typeof disclosures.$inferSelect;
export type Block = typeof blocks.$inferSelect;
export type TxAddress = typeof txAddresses.$inferSelect;
