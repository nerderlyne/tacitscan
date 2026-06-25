// Thin client over the Esplora REST API.
// Public free instances: mempool.space, blockstream.info.
// Same interface ports cleanly to a managed provider later — just swap
// the BitcoinDataSource impl.
import { AbortError } from "p-retry";
import type { BitcoinDataSource, FullBlock } from "./source.js";

export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  // null means "fee unknown" (e.g. RPC source doesn't include it without
  // an extra prevout fetch). Esplora always populates it.
  fee: number | null;
  vin: EsploraTxInput[];
  vout: EsploraTxOutput[];
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

export interface EsploraTxInput {
  txid: string;
  vout: number;
  prevout?: EsploraTxOutput | null;
  scriptsig: string;
  scriptsig_asm: string;
  witness?: string[];
  is_coinbase: boolean;
  sequence: number;
}

export interface EsploraTxOutput {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraBlock {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  merkle_root: string;
  previousblockhash: string | null;
  nonce: number;
  bits: number;
  difficulty: number;
}

export class EsploraClient implements BitcoinDataSource {
  readonly name: string;
  // Timestamp (ms) until which we hold off firing the next request. A 429
  // pushes this forward so the whole client self-paces under throttling
  // instead of hammering the endpoint and tripping more rate limits.
  private paceUntil = 0;
  constructor(
    private readonly primary: string,
    private readonly fallback?: string,
    // Optional auth headers, e.g. {"api-key": "..."} for Maestro. Merged
    // into every request. We don't bake provider-specific knowledge in;
    // the caller in indexer.ts decides what to send.
    private readonly authHeaders?: Record<string, string>,
    nameOverride?: string,
  ) {
    this.name = nameOverride ?? "esplora";
  }

  async fetchBlock(height: number): Promise<FullBlock> {
    const hash = await this.getBlockHashByHeight(height);
    const block = await this.getBlock(hash);
    const txs = await this.getAllBlockTxs(hash, block.tx_count);
    return {
      hash: block.id,
      height: block.height,
      timestamp: block.timestamp,
      previousblockhash: block.previousblockhash,
      tx_count: block.tx_count,
      txs,
    };
  }

  private endpoints(): string[] {
    return this.fallback ? [this.primary, this.fallback] : [this.primary];
  }

  private fetchJson<T>(path: string): Promise<T> {
    return this.request(path, (r) => r.json() as Promise<T>);
  }

  private fetchText(path: string): Promise<string> {
    return this.request(path, (r) => r.text());
  }

  // Rate-limit-aware fetch with endpoint failover.
  //
  // The public Esplora instances we fall back to (mempool.space) throttle
  // hard. Rather than let a 429 bubble up and take down the walker, we
  // honor Retry-After, back off, and keep retrying — the indexer simply
  // slows down under load instead of failing. A genuine 404 is the only
  // terminal outcome (AbortError, so withFallback can try another source).
  // Other transient errors get a bounded retry; if they still fail we throw
  // and the walker loop in runIndexer() catches, sleeps, and retries the
  // whole iteration — so nothing here can crash the process.
  private async request<T>(path: string, parse: (r: Response) => Promise<T>): Promise<T> {
    // How many non-rate-limit transient failures to tolerate before
    // throwing back to the loop guard. 429s are NOT counted against this —
    // they retry until they clear.
    const maxTransientAttempts = 6;
    let transientAttempts = 0;
    let rlAttempts = 0;
    while (true) {
      // Respect any cooldown a prior 429 imposed.
      const wait = this.paceUntil - Date.now();
      if (wait > 0) await sleep(wait);

      let lastErr: unknown;
      let rateLimited = false;
      let retryAfterMs = 0;
      for (const base of this.endpoints()) {
        try {
          const r = await fetch(`${base}${path}`, {
            headers: { "user-agent": "tacitscan-indexer/0.1", ...this.authHeaders },
            // Hard ceiling so a hung connection can't trap the loop.
            signal: AbortSignal.timeout(15_000),
          });
          // Auth / billing / not-found: retrying won't help. Throw terminal
          // so withFallback moves to the next source immediately instead of
          // burning the transient-retry budget on a hard-down endpoint
          // (e.g. Maestro 402 "payment required", a lapsed-plan 403, a 404).
          if (TERMINAL_STATUSES.has(r.status)) throw new AbortError(`HTTP ${r.status}: ${path}`);
          if (r.status === 429) {
            rateLimited = true;
            retryAfterMs = Math.max(retryAfterMs, parseRetryAfter(r.headers.get("retry-after")));
            lastErr = new Error(`HTTP 429 from ${base}${path}`);
            continue; // try the other endpoint before backing off
          }
          if (!r.ok) {
            lastErr = new Error(`HTTP ${r.status} from ${base}${path}`);
            continue;
          }
          // Success — let the pace decay back toward zero.
          this.paceUntil = 0;
          return await parse(r);
        } catch (e) {
          if (e instanceof AbortError) throw e;
          lastErr = e;
        }
      }

      if (rateLimited) {
        // Slow down and keep going — never give up on throttling.
        rlAttempts++;
        const backoff = retryAfterMs || Math.min(30_000, 1000 * 2 ** Math.min(rlAttempts, 5));
        this.paceUntil = Date.now() + backoff;
        console.warn(`[${this.name}] rate limited on ${path}; slowing down ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      // Non-rate-limit transient (5xx, network, timeout): bounded retry,
      // then throw up to the loop guard.
      transientAttempts++;
      if (transientAttempts >= maxTransientAttempts) {
        throw lastErr ?? new Error(`fetch failed: ${path}`);
      }
      await sleep(Math.min(5000, 500 * 2 ** transientAttempts));
    }
  }

  async getTipHeight(): Promise<number> {
    const t = await this.fetchText(`/blocks/tip/height`);
    return Number(t.trim());
  }

  async getBlockHashByHeight(height: number): Promise<string> {
    return (await this.fetchText(`/block-height/${height}`)).trim();
  }

  async getBlock(hash: string): Promise<EsploraBlock> {
    return this.fetchJson<EsploraBlock>(`/block/${hash}`);
  }

  // Esplora returns block transactions in pages of 25, ordered by tx_index.
  async getBlockTxs(hash: string, startIndex: number): Promise<EsploraTx[]> {
    return this.fetchJson<EsploraTx[]>(`/block/${hash}/txs/${startIndex}`);
  }

  async getMempoolTxids(): Promise<string[]> {
    return this.fetchJson<string[]>(`/mempool/txids`);
  }

  async fetchTx(txid: string): Promise<EsploraTx> {
    return this.fetchJson<EsploraTx>(`/tx/${txid}`);
  }

  // Fetch all tx pages of a block in parallel. Esplora pages are 25 txs
  // each — a 3000-tx mainnet block is 120 page calls. Sequential at ~50ms
  // each = 6s per block; parallel-bounded at concurrency 8 ≈ 750ms.
  async getAllBlockTxs(hash: string, txCount: number, concurrency = 8): Promise<EsploraTx[]> {
    const offsets: number[] = [];
    for (let i = 0; i < txCount; i += 25) offsets.push(i);
    const results: EsploraTx[][] = new Array(offsets.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, offsets.length) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= offsets.length) return;
        results[idx] = await this.getBlockTxs(hash, offsets[idx]!);
      }
    });
    await Promise.all(workers);
    const out: EsploraTx[] = [];
    for (const page of results) if (page) out.push(...page);
    return out;
  }
}

// Client errors that retrying can't fix — fall back to the next source at
// once. 429 is deliberately excluded; it means "slow down", handled above.
const TERMINAL_STATUSES = new Set([400, 401, 402, 403, 404]);

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Retry-After is either delta-seconds or an HTTP date. We honor the
// numeric (seconds) form — the only one mempool.space sends — and ignore
// the date form, falling back to our own exponential backoff (returns 0).
function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const secs = Number(header.trim());
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs, 60) * 1000 : 0;
}
