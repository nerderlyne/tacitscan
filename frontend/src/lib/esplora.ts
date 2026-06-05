// Tiny Esplora client used at render time to lazily backfill data the
// indexer didn't have (notably per-tx fees, which dRPC's getblock v2
// doesn't include). One call per cold tx-page view; result is written
// back to Postgres so subsequent views are free.
const ESPLORA_BASES = [
  "https://mempool.space/api",
  "https://blockstream.info/api",
];

export async function fetchTxFee(txid: string): Promise<number | null> {
  for (const base of ESPLORA_BASES) {
    try {
      const r = await fetch(`${base}/tx/${txid}`, {
        signal: AbortSignal.timeout(2500),
        headers: { "user-agent": "tacitscan-frontend/0.1" },
      });
      if (!r.ok) continue;
      const data = (await r.json()) as { fee?: number };
      if (typeof data.fee === "number") return data.fee;
    } catch {
      // try next base
    }
  }
  return null;
}

export interface AddressStats {
  funded: number;
  spent: number;
  txCount: number;
}

// Esplora's /address/<addr> returns funded+spent sat totals for both
// the confirmed chain and the mempool. We combine them — the address
// page's "Balance" is `(chain funded + mempool funded) − (chain spent
// + mempool spent)`, which matches how block explorers typically show
// it (balance updates as soon as a spending tx hits the mempool).
export async function fetchAddressStats(addr: string): Promise<AddressStats | null> {
  for (const base of ESPLORA_BASES) {
    try {
      const r = await fetch(`${base}/address/${encodeURIComponent(addr)}`, {
        signal: AbortSignal.timeout(3500),
        headers: { "user-agent": "tacitscan-frontend/0.1" },
      });
      if (!r.ok) continue;
      const data = (await r.json()) as {
        chain_stats?: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
        mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
      };
      const c = data.chain_stats ?? { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 };
      const m = data.mempool_stats ?? { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 };
      return {
        funded: c.funded_txo_sum + m.funded_txo_sum,
        spent: c.spent_txo_sum + m.spent_txo_sum,
        txCount: c.tx_count + m.tx_count,
      };
    } catch {
      // try next base
    }
  }
  return null;
}

export interface AddressUtxo {
  txid: string;
  vout: number;
  value: number;
  confirmed: boolean;
  blockHeight?: number;
}

export interface TxIO {
  vin: { addr: string | null; scriptType: string | null }[];
  vout: { n: number; addr: string | null; scriptType: string; value: number }[];
}

// Fetch a tx's vin prevout addresses + vout addresses so the tx page can
// render the recipient set. Used to distinguish recipient outputs from
// sender's change (vouts whose address also appears in any vin prevout).
// One Esplora call per cold render; cache lives at the CDN layer.
export async function fetchTxIO(txid: string): Promise<TxIO | null> {
  for (const base of ESPLORA_BASES) {
    try {
      const r = await fetch(`${base}/tx/${txid}`, {
        signal: AbortSignal.timeout(3500),
        headers: { "user-agent": "tacitscan-frontend/0.1" },
      });
      if (!r.ok) continue;
      const data = (await r.json()) as {
        vin: Array<{
          prevout?: {
            scriptpubkey_address?: string;
            scriptpubkey_type?: string;
          } | null;
        }>;
        vout: Array<{
          scriptpubkey_address?: string;
          scriptpubkey_type: string;
          value: number;
        }>;
      };
      return {
        vin: data.vin.map((v) => ({
          addr: v.prevout?.scriptpubkey_address ?? null,
          scriptType: v.prevout?.scriptpubkey_type ?? null,
        })),
        vout: data.vout.map((o, n) => ({
          n,
          addr: o.scriptpubkey_address ?? null,
          scriptType: o.scriptpubkey_type,
          value: o.value,
        })),
      };
    } catch {
      // try next base
    }
  }
  return null;
}

export async function fetchAddressUtxos(addr: string): Promise<AddressUtxo[] | null> {
  for (const base of ESPLORA_BASES) {
    try {
      const r = await fetch(`${base}/address/${encodeURIComponent(addr)}/utxo`, {
        signal: AbortSignal.timeout(3500),
        headers: { "user-agent": "tacitscan-frontend/0.1" },
      });
      if (!r.ok) continue;
      const data = (await r.json()) as Array<{
        txid: string;
        vout: number;
        value: number;
        status: { confirmed: boolean; block_height?: number };
      }>;
      return data.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        confirmed: u.status.confirmed,
        blockHeight: u.status.block_height,
      }));
    } catch {
      // try next base
    }
  }
  return null;
}
