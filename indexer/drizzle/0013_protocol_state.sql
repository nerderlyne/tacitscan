-- Public settlement effects. Candidate calldata is never counted as accepted.
CREATE TABLE IF NOT EXISTS protocol_settlements (
  chain_id integer NOT NULL, deployment text NOT NULL, txid text NOT NULL,
  call_index integer NOT NULL, block_height bigint NOT NULL, block_hash text NOT NULL,
  authority text NOT NULL, public_values jsonb NOT NULL, memos jsonb NOT NULL,
  calldata text NOT NULL, decode_error text,
  PRIMARY KEY(chain_id,txid,call_index)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS protocol_settlements_height_idx ON protocol_settlements(chain_id,block_height);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_validation_jobs (
  network text NOT NULL, txid text NOT NULL, vout integer NOT NULL,
  block_height integer NOT NULL, block_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending', evidence jsonb,
  checked_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network,txid,vout)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS protocol_validation_pending_idx ON protocol_validation_jobs(network,next_attempt_at) WHERE status='pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_reference_records (
  source text NOT NULL,generation text NOT NULL,kind text NOT NULL,record_key text NOT NULL,
  body jsonb NOT NULL,block_height bigint,PRIMARY KEY(source,generation,kind,record_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS protocol_reference_records_height_idx ON protocol_reference_records(source,generation,block_height);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS protocol_state_changes (
  source text NOT NULL,epoch text NOT NULL,seq bigint NOT NULL,kind text NOT NULL,
  record_key text NOT NULL,body jsonb,deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(source,epoch,seq)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS protocol_state_changes_record_idx ON protocol_state_changes(source,epoch,kind,record_key,seq DESC);
--> statement-breakpoint
CREATE OR REPLACE VIEW protocol_effects AS
SELECT s.chain_id,s.deployment,s.txid,s.call_index,s.block_height,s.block_hash,
       f.key AS kind,e.ordinality AS effect_index,e.value AS body
FROM protocol_settlements s
CROSS JOIN LATERAL jsonb_each(s.public_values) f
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.value)='array' THEN f.value ELSE '[]'::jsonb END) WITH ORDINALITY e
WHERE s.authority IN ('direct-pool-call','successful-call-trace') AND s.decode_error IS NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW protocol_note_entries AS
SELECT chain_id,address AS deployment,'note'::text AS tree,
       (decoded->>'firstLeafIndex')::numeric+l.ordinality-1 AS leaf_index,
       l.value AS leaf,decoded->'memos'->(l.ordinality::integer-1) AS memo,txid,block_height,block_hash
FROM protocol_events CROSS JOIN LATERAL jsonb_array_elements(decoded->'leaves') WITH ORDINALITY l
WHERE event_name='LeavesInserted'
UNION ALL
SELECT e.chain_id,e.address,'lock',(e.decoded->>'firstLockIndex')::numeric+l.ordinality-1,l.value,
       (SELECT CASE WHEN count(*)=1 THEN jsonb_agg(s.memos->(jsonb_array_length(s.public_values->'leaves')+l.ordinality::integer-1))->0 ELSE NULL::jsonb END
        FROM protocol_settlements s WHERE s.chain_id=e.chain_id AND s.txid=e.txid AND s.deployment=e.address
          AND s.authority IN ('direct-pool-call','successful-call-trace') AND s.decode_error IS NULL
          AND s.public_values->'lockLeaves'=e.decoded->'lockLeaves'
          AND jsonb_array_length(s.memos)=jsonb_array_length(s.public_values->'leaves')+jsonb_array_length(s.public_values->'lockLeaves')),
       e.txid,e.block_height,e.block_hash
FROM protocol_events e CROSS JOIN LATERAL jsonb_array_elements(e.decoded->'lockLeaves') WITH ORDINALITY l
WHERE e.event_name='LockLeavesInserted'
UNION ALL
SELECT chain_id,address,'cdp',row_number() OVER(PARTITION BY chain_id,address ORDER BY block_height,log_index)-1,decoded->'leaf',NULL::jsonb,txid,block_height,block_hash
FROM protocol_events WHERE event_name='CdpPositionInserted'
UNION ALL
SELECT chain_id,address,'evm-pool',(decoded->>'firstIndex')::numeric,decoded->'outLeaf0',decoded->'memo0',txid,block_height,block_hash
FROM protocol_events WHERE event_name='Transact' AND (decoded->>'outLeaf0'<>'0x0000000000000000000000000000000000000000000000000000000000000000' OR decoded->>'outLeaf1'<>'0x0000000000000000000000000000000000000000000000000000000000000000')
UNION ALL
SELECT chain_id,address,'evm-pool',(decoded->>'firstIndex')::numeric+1,
       decoded->'outLeaf1',decoded->'memo1',txid,block_height,block_hash
FROM protocol_events WHERE event_name='Transact' AND (decoded->>'outLeaf1'<>'0x0000000000000000000000000000000000000000000000000000000000000000' OR decoded->>'outLeaf0'<>'0x0000000000000000000000000000000000000000000000000000000000000000');
--> statement-breakpoint
CREATE OR REPLACE VIEW protocol_nullifier_entries AS
SELECT chain_id,address AS deployment,'note'::text AS tree,n.value AS nullifier,txid,block_height,block_hash
FROM protocol_events CROSS JOIN LATERAL jsonb_array_elements(decoded->'nullifiers') n
WHERE event_name='NullifiersSpent'
UNION ALL
SELECT chain_id,deployment,'lock',body,txid,block_height,block_hash FROM protocol_effects WHERE kind='lockNullifiers'
UNION ALL
SELECT chain_id,deployment,'cdp',CASE WHEN kind='cdpTopups' THEN body->'oldPositionNullifier' ELSE body->'positionNullifier' END,txid,block_height,block_hash FROM protocol_effects WHERE kind IN ('cdpCloses','cdpLiquidations','cdpTopups')
UNION ALL
SELECT chain_id,address,'evm-pool',decoded->'nf0',txid,block_height,block_hash FROM protocol_events WHERE event_name='Transact' AND decoded->>'nf0'<>'0x0000000000000000000000000000000000000000000000000000000000000000'
UNION ALL
SELECT chain_id,address,'evm-pool',decoded->'nf1',txid,block_height,block_hash FROM protocol_events WHERE event_name='Transact' AND decoded->>'nf1'<>'0x0000000000000000000000000000000000000000000000000000000000000000';
