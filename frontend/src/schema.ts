// Mirror of indexer/src/schema.ts. KEEP IN SYNC if you edit either side.
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

export const cursor = pgTable("cursor", {
  network: text("network").primaryKey(),
  lastIndexedHeight: integer("last_indexed_height").notNull(),
  lastIndexedBlockHash: text("last_indexed_block_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assets = pgTable(
  "assets",
  {
    assetId: text("asset_id").primaryKey(),
    network: text("network").notNull(),
    kind: text("kind").notNull(),
    ticker: text("ticker").notNull(),
    decimals: integer("decimals").notNull(),
    imageUri: text("image_uri"),
    creatorPubkey: text("creator_pubkey"),
    mintAuthority: text("mint_authority"),
    capAmount: bigint("cap_amount", { mode: "bigint" }),
    mintLimit: bigint("mint_limit", { mode: "bigint" }),
    mintStartHeight: integer("mint_start_height"),
    mintEndHeight: integer("mint_end_height"),
    etchTxid: text("etch_txid").notNull(),
    etchHeight: integer("etch_height").notNull(),
    etchBlockTime: timestamp("etch_block_time", { withTimezone: true }).notNull(),
    resolvedImageUrl: text("resolved_image_url"),
    imageResolvedAt: timestamp("image_resolved_at", { withTimezone: true }),
    imageResolveError: text("image_resolve_error"),
  },
  (t) => ({
    tickerIdx: index("assets_ticker_idx").on(t.ticker),
    networkHeightIdx: index("assets_network_height_idx").on(t.network, t.etchHeight),
  }),
);

export const envelopes = pgTable(
  "envelopes",
  {
    txid: text("txid").primaryKey(),
    network: text("network").notNull(),
    opcode: text("opcode").notNull(),
    assetId: text("asset_id"),
    blockHeight: integer("block_height"),
    blockHash: text("block_hash"),
    blockTime: timestamp("block_time", { withTimezone: true }),
    txIndex: integer("tx_index"),
    chainStatus: text("chain_status").notNull().default("confirmed"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    inputCount: integer("input_count").notNull(),
    outputCount: integer("output_count").notNull(),
    feeSats: bigint("fee_sats", { mode: "bigint" }),
    burnedAmount: bigint("burned_amount", { mode: "bigint" }),
    publicAmount: bigint("public_amount", { mode: "bigint" }),
    n: integer("n"),
    assetInputCount: integer("asset_input_count"),
    denomination: bigint("denomination", { mode: "bigint" }),
    etchTxid: text("etch_txid"),
    isPoolInit: boolean("is_pool_init").notNull().default(false),
    rawWitness: bytea("raw_witness").notNull(),
    rawPayload: bytea("raw_payload").notNull(),
    kernelSig: bytea("kernel_sig"),
    issuerSig: bytea("issuer_sig"),
    rangeproof: bytea("rangeproof"),
    proofBytes: bytea("proof_bytes"),
    merkleRoot: text("merkle_root"),
    nullifierHash: text("nullifier_hash"),
    status: text("status").notNull().default("ok"),
    decodeError: text("decode_error"),
    spendingPubkey: text("spending_pubkey"),
    commitTxid: text("commit_txid"),
    denomWei: text("denom_wei"),
    ethRecipient: text("eth_recipient"),
    commitmentValid: boolean("commitment_valid"),
    commitmentCheckedAt: timestamp("commitment_checked_at", { withTimezone: true }),
    commitmentInvalidReason: text("commitment_invalid_reason"),
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

export const commitments = pgTable(
  "commitments",
  {
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
    network: text("network").notNull(),
    assetId: text("asset_id").notNull(),
    commitmentC: bytea("commitment_c").notNull(),
    encryptedAmount: bytea("encrypted_amount"),
    blockHeight: integer("block_height").notNull(),
    isPublicOpening: boolean("is_public_opening").notNull().default(false),
    publicAmount: bigint("public_amount", { mode: "bigint" }),
    publicBlinding: bytea("public_blinding"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txid, t.vout] }),
    assetIdx: index("commitments_asset_idx").on(t.assetId, t.blockHeight),
  }),
);

export const disclosures = pgTable("disclosures", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),
  ownerPubkey: text("owner_pubkey").notNull(),
  threshold: bigint("threshold", { mode: "bigint" }).notNull(),
  utxos: text("utxos").array().notNull(),
  rangeproof: bytea("rangeproof").notNull(),
  sig: bytea("sig").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const txAddresses = pgTable(
  "tx_addresses",
  {
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    address: text("address").notNull(),
    role: text("role").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.network, t.txid, t.address, t.role] }),
    addrIdx: index("tx_addresses_addr_idx").on(t.address, t.network),
  }),
);

export type Asset = typeof assets.$inferSelect;
export type Envelope = typeof envelopes.$inferSelect;
export type Commitment = typeof commitments.$inferSelect;
