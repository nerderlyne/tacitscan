// Disambiguates assets with the same ticker (per SPEC §4: ticker is NOT
// unique, multiple T_PETCHes can share the same human-readable name).
// `unique` ticker → just the ticker. Collision → `TICKER#<8-hex>` of the
// asset_id. 8 hex chars = 32 bits of fingerprint — meaningfully more
// expensive to prefix-mine than a 4-char version, still readable.
export function displayAssetName(
  ticker: string,
  assetId: string,
  hasCollision: boolean,
): string {
  if (!hasCollision) return ticker;
  return `${ticker}#${assetId.slice(0, 8)}`;
}

export function shortHex(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function bytesToHex(b: Uint8Array | null | undefined): string {
  if (!b) return "";
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function formatAmount(units: bigint | null | undefined, decimals: number | null | undefined): string {
  if (units === null || units === undefined) return "—";
  const d = decimals ?? 0;
  if (d === 0) return units.toString();
  const s = units.toString().padStart(d + 1, "0");
  const head = s.slice(0, -d);
  const tail = s.slice(-d).replace(/0+$/, "");
  return tail ? `${head}.${tail}` : head;
}

export function relativeTime(t: Date | string | null | undefined): string {
  if (t == null) return "—";
  const ms = (typeof t === "string" ? new Date(t) : t).getTime();
  if (!Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Resolve `ipfs://<cid>` (or `ipfs://ipfs/<cid>`) to a public gateway URL.
// Returns null for empty/invalid input. Direct https:// URIs pass through.
// Cloudflare-fronted IPFS gateway — fast cache hits across regions.
// Used as the public-facing URL we show to users. Resolver server-side
// retains a fallback list in case any single gateway flakes.
const GATEWAY = "https://content.wrappr.wtf/ipfs/";

export function resolveImageUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  if (trimmed.startsWith("ipfs://")) {
    let cid = trimmed.slice("ipfs://".length);
    if (cid.startsWith("ipfs/")) cid = cid.slice("ipfs/".length);
    if (!cid) return null;
    return `${GATEWAY}${cid}`;
  }
  // Bare CID heuristic: starts with "bafy", "bafk", "bafr" or "Qm".
  if (/^(baf[ykr]|Qm)/.test(trimmed)) {
    return `${GATEWAY}${trimmed}`;
  }
  return null;
}

export const OPCODE_DESCRIPTIONS: Record<string, string> = {
  CETCH: "Confidential etch — issues a new asset with hidden supply.",
  CXFER: "Confidential transfer — moves balances without revealing amounts.",
  T_MINT: "Issuer mint — adds supply on a mintable CETCH asset.",
  T_BURN: "Burn — destroys supply (amount public).",
  T_AXFER: "Atomic OTC settlement — confidential transfer mixed with BTC payment.",
  T_PETCH: "Permissionless-mint deployment — declares a fair-launch asset.",
  T_PMINT: "Permissionless mint — claims a tranche against a T_PETCH (amount public).",
  T_DEPOSIT: "Mixer deposit — anonymizes a UTXO into a per-asset pool.",
  T_WITHDRAW: "Mixer withdrawal — anonymous mint from a pool, gated by zk proof.",
  T_DROP: "Public-claim pool — locks existing supply for permissionless claims (airdrop).",
  T_DCLAIM: "Public-claim event — claim against a T_DROP pool.",
  T_AXFER_VAR: "Variable-amount atomic OTC settlement — taker-chosen amount, BP rangeproof on BTC leg.",
  T_CXFER_BPP: "Confidential transfer — CXFER variant with Bulletproofs+ rangeproof (~14% smaller witness).",
  T_WRAPPER_ATTEST: "Wrapper attestation — issuer pins external-wallet → tacit-key binding on chain.",
  T_SLOT_MINT: "cBTC.zk slot mint — locks BTC at a slot address and mints a wrapper asset note.",
  T_SLOT_BURN: "cBTC.zk slot redeem — burns the wrapper note and releases the BTC slot.",
  T_SLOT_ROTATE: "cBTC.zk slot rotation — trustless slot transfer; supply conserved.",
  T_SLOT_SPLIT: "cBTC.zk slot split — atomically split one slot into N smaller ones.",
  T_SLOT_MERGE: "cBTC.zk slot merge — atomically merge N slots into one.",
  T_CBTC_TAC_DEPOSIT: "cBTC.tac mint — LP-share lien backing a cBTC.zk slot.",
  T_CBTC_TAC_FORCE_CLOSE: "cBTC.tac force-close — permissionless liquidation when collateral ratio drops.",
  T_CTAC_LIEN_SPLIT: "cBTC.tac lien split — split a liened LP-share UTXO; lien inherits onto one output.",
  T_BRIDGE_DEPOSIT: "tETH bridge deposit — trustless mint of tETH on Tacit by proving a deposit into the Ethereum mixer contract.",
  T_BRIDGE_BURN: "tETH bridge burn — trustless redeem of tETH to an Ethereum recipient; this Bitcoin tx becomes the proof artifact.",
  T_BRIDGE_ROTATE: "tETH bridge rotate — atomic tETH transfer between Tacit wallets (burn old leaf + mint new leaf, one sig).",
  T_BRIDGE_NOTE: "tETH bridge note — encrypted recipient-detection memo; only the recipient's viewing key decrypts.",
  UNKNOWN: "Malformed or unrecognized envelope.",
  // Asset-kind aliases use the same descriptions (cetch/t_petch are also opcodes).
  cetch: "Confidential etch — issues a new asset with hidden supply.",
  t_petch: "Permissionless-mint deployment — declares a fair-launch asset.",
};

export function describeBadge(label: string | null | undefined): string {
  if (!label) return "";
  return OPCODE_DESCRIPTIONS[label] ?? OPCODE_DESCRIPTIONS[label.toUpperCase()] ?? "";
}

// Split the "UNKNOWN" bucket into the two cases users actually care about:
//   1. Forward-compat — wrapper parsed fine, but the opcode byte is outside
//      the v1 spec. Per SPEC §5 the indexer treats it as a no-op. Not an
//      error: future-spec opcodes look exactly like this to a v1 indexer.
//   2. Malformed — wrapper didn't decode (empty payload, trailing bytes,
//      sub-decoder threw). This IS a real malformation.
//
// The persisted `decode_error` string carries the discriminator: matches
// /^unknown opcode 0x[0-9a-f]+$/ for case 1, anything else for case 2.
export function describeUnknownEnvelope(decodeError: string | null | undefined): {
  label: string;
  detail: string;
  isForwardCompat: boolean;
} {
  const m = decodeError?.match(/^unknown opcode (0x[0-9a-f]+)$/i);
  if (m) {
    return {
      label: `Unknown opcode ${m[1]}`,
      detail:
        "Envelope wrapper parsed correctly but the opcode byte isn't defined in the v1 spec. " +
        "Per SPEC §5 the indexer treats this as a no-op — it could be a future-spec opcode, " +
        "a wallet bug, or someone testing the envelope path.",
      isForwardCompat: true,
    };
  }
  return {
    label: "Malformed envelope",
    detail: decodeError
      ? `Witness bytes didn't decode as a Tacit envelope: ${decodeError}.`
      : "Witness bytes didn't decode as a Tacit envelope.",
    isForwardCompat: false,
  };
}
