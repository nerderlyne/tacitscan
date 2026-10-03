-- Additive only: existing tables, keys and application queries remain usable.
CREATE TABLE IF NOT EXISTS protocol_envelopes (
  network text NOT NULL, txid text NOT NULL, input_index integer NOT NULL,
  opcode text NOT NULL, opcode_byte integer NOT NULL, family text NOT NULL,
  support text NOT NULL, asset_id text, block_height integer, block_hash text,
  tx_index integer, chain_status text NOT NULL, decoded jsonb NOT NULL,
  raw_payload bytea NOT NULL, raw_script bytea NOT NULL, carrier jsonb NOT NULL,
  decode_status text NOT NULL, decode_error text,
  validation_status text NOT NULL DEFAULT 'unchecked', validation_evidence jsonb,
  decoder_version integer NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, txid, input_index)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS protocol_envelopes_activity_idx ON protocol_envelopes(network, block_height DESC, tx_index DESC, input_index);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS protocol_envelopes_asset_idx ON protocol_envelopes(network, asset_id, block_height DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_spends (
  network text NOT NULL, source_txid text NOT NULL, source_vout integer NOT NULL,
  spending_txid text NOT NULL, block_height integer NOT NULL, block_hash text NOT NULL,
  PRIMARY KEY(network, source_txid, source_vout)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_outputs (
  network text NOT NULL, txid text NOT NULL, vout integer NOT NULL, asset_id text NOT NULL,
  commitment text NOT NULL, encrypted_amount text, block_height integer NOT NULL,
  block_hash text NOT NULL, validation_status text NOT NULL DEFAULT 'unchecked',
  PRIMARY KEY(network,txid,vout)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_cursors (
  source text PRIMARY KEY, height bigint NOT NULL, block_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), error text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_blocks (
  source text NOT NULL, height bigint NOT NULL, block_hash text NOT NULL,
  PRIMARY KEY(source,height)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_events (
  chain_id integer NOT NULL, address text NOT NULL, txid text NOT NULL, log_index integer NOT NULL,
  block_height bigint NOT NULL, block_hash text NOT NULL, family text NOT NULL,
  event_name text NOT NULL, decoded jsonb NOT NULL, raw_log jsonb NOT NULL,
  PRIMARY KEY(chain_id,txid,log_index)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS protocol_events_activity_idx ON protocol_events(chain_id,block_height DESC,log_index DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_snapshots (
  source text NOT NULL, resource text NOT NULL, body jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(), error text,
  PRIMARY KEY(source,resource)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_assets (
  chain_id integer NOT NULL, deployment text NOT NULL, asset_id text NOT NULL,
  origin text NOT NULL, token_address text, symbol text, name text, decimals integer,
  unit_scale text, block_height bigint NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(chain_id,deployment,asset_id)
);
