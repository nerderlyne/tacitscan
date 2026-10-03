-- Coverage is written in the same transaction as its derived records.
CREATE TABLE protocol_scan_windows (
  source text NOT NULL,
  first_height bigint NOT NULL,
  last_height bigint NOT NULL CHECK(last_height>=first_height),
  block_hash text NOT NULL,
  revision text NOT NULL,
  decoder_version integer NOT NULL,
  traced boolean NOT NULL DEFAULT false,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source,first_height,last_height)
);
--> statement-breakpoint
CREATE INDEX protocol_scan_windows_source_end ON protocol_scan_windows(source,last_height);
--> statement-breakpoint
ALTER TABLE protocol_validation_jobs ADD COLUMN last_error text;

--> statement-breakpoint
CREATE INDEX protocol_events_contract_kind_height ON protocol_events(chain_id,address,event_name,block_height,log_index);
--> statement-breakpoint
CREATE INDEX protocol_events_decoded_gin ON protocol_events USING gin(decoded jsonb_path_ops);
