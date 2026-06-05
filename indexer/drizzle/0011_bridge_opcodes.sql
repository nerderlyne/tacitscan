-- SPEC-TETH-BRIDGE-AMENDMENT (§5.60–§5.63) — four new bridge opcodes:
--   T_BRIDGE_DEPOSIT  (0x60)  trustless tETH mint via ETH mixer proof
--   T_BRIDGE_BURN     (0x61)  trustless tETH redeem to ETH recipient
--   T_BRIDGE_ROTATE   (0x62)  atomic tETH transfer (burn old + mint new)
--   T_BRIDGE_NOTE     (0x63)  encrypted recipient-detection memo
--
-- Two columns to render the bridge-specific fields cleanly:
--   denom_wei      — u256 wei value as decimal string. Pools ≥ 10 ETH
--                    (1e20 wei) overflow Postgres BIGINT, so we store
--                    the canonical decimal representation and format
--                    in the frontend.
--   eth_recipient  — the 20-byte Ethereum address a T_BRIDGE_BURN /
--                    T_BRIDGE_ROTATE will pay out to on the ETH side,
--                    as 40-char hex.
--
-- Both nullable; populated only on bridge-opcode rows.

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS denom_wei text;
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS eth_recipient text;
