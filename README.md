# tacitscan

Block explorer for [Tacit](https://github.com/z0r0z/tacit), the confidential
token meta-protocol on Bitcoin. Live at **[tacitscan.io](https://tacitscan.io)**.

Source: [github.com/nerderlyne/tacitscan](https://github.com/nerderlyne/tacitscan).

```
tacitscan/
├── indexer/    Node + TypeScript. Reads Bitcoin via dRPC (or Esplora),
│               decodes envelopes, writes Postgres. Runs on Render.
└── frontend/   Astro SSR. Queries Postgres directly, ships near-zero JS.
                Runs on Render.
```

Both subdirs deploy independently and share a Postgres. There are no
workspace links between them — `frontend/src/schema.ts` is a copy of
`indexer/src/schema.ts`. Keep the two in sync if you change either.

---

## Architecture

```
   Bitcoin                  ┌──── dRPC (primary) ─────┐
  ───────────►              │                         ▼
                            │              ┌──────────────────┐
                            └── mempool ──►│     indexer      │  Render
                                fallback   │                  │
                                           │  block walk      │
                                           │  decode envelope │
                                           │  upsert          │
                                           └────────┬─────────┘
                                                    │
                                                    ▼
                                           ┌──────────────────┐
                                           │     Postgres     │
                                           └────────┬─────────┘
                                                    │
                                                    ▼
                                           ┌──────────────────┐
                                           │     frontend     │  Render
                                           │     Astro SSR    │
                                           └──────────────────┘
```

Bitcoin data flows in via two interchangeable backends:

- [**dRPC**](https://drpc.org) — Bitcoin Core JSON-RPC. Set
  `BITCOIN_RPC_URL` to use as the primary fast path. One `getblock` call
  returns a full block + every tx with witness data, vs Esplora's many
  paginated calls. ~50–100× faster backfill.
- [**mempool.space**](https://mempool.space) (Esplora REST) — free public
  API, used as the always-on fallback if dRPC errors or is unset. Also
  the default for new deploys with no paid RPC.

The indexer is a tip-following block walker (Ponder-shaped: cursor table,
per-opcode handlers, idempotent upserts on PK). Decoded envelopes are
written into Postgres with their raw bytes preserved for later inspection.
Parsing and protocol acceptance are separate. The legacy mint checks remain;
the opt-in accepted-state worker uses the pinned upstream validator and proof
replay services in `runtime/`. EVM indexing covers public events and successful
protocol calls. See [protocol rollout](docs/protocol-rollout.md) for the feature
flags, required archive RPC methods, staging replay and readiness gate.

The frontend is Astro SSR. Pages query Postgres directly via Drizzle and
ship as static-feeling HTML. Two interactive bits — the search bar and
the live recent-envelopes feed — are vanilla `<script>` islands.

---

## Local development

You need:

- Node 24+
- pnpm (or npm)
- A Postgres URL. The fastest path is a free [Neon](https://neon.tech) project.

### 1. Postgres

Create a project on Neon (or any Postgres) and copy the **pooled** connection
string. Both apps will use the same DB.

### 2. Indexer

```bash
cd indexer
cp .env.example .env
# edit .env: paste DATABASE_URL, choose START_HEIGHT
pnpm install
pnpm db:migrate         # apply ./drizzle/*.sql
pnpm dev                # starts the block walker
```

You should see lines like:

```
[mainnet] starting at height 860001, source=https://mempool.space/api
[mainnet] 860001..860010 (+0 envelopes) in 4.2s, tip=863412
```

The first run backfills from `START_HEIGHT` to current tip. With public
Esplora that's bound by HTTP rate limits — expect ~5–15 blocks/sec in
steady state. Set `START_HEIGHT` close to Tacit's genesis on the network
you target so backfill finishes in hours, not days.

### 3. Frontend

```bash
cd frontend
cp .env.example .env
# edit .env: same DATABASE_URL (Neon pooled URL)
pnpm install
pnpm dev                # http://localhost:4321
```

---

## Deploy

The `render.yaml` Blueprint uses the existing frontend, indexer worker and
explorer database. The worker runs canonical replay and pool verification as
supervised child processes with localhost-only endpoints. Canonical state uses
the `tacitscan_canonical` Postgres schema; pool SQLite uses the worker disk.
Both services track `main` and deploy on commits.

Before the first release, enable Blueprint **Auto Sync** and create the Render
environment group `tacitscan-parity-secrets` with `RPC_ETH`, `RPC_BASE`, `RPC_ROBINHOOD` and a reviewed
`BTC_POOL_CHECKPOINT`. These match the names accepted in the local `.env`.
Ethereum needs historical call tracing. Credentials stay in Render.

The indexer automatically migrates and resumes historical repair before live
ingestion. Protocol views activate only after a fresh readiness report passes;
existing Bitcoin pages remain available while indexes catch up. Worker deployments
stop the old writer before starting the new one. The worker retains the original starter compute plan. Its new persistent disk incurs Render charges; monitor
worker memory and database capacity as history grows.

See [the rollout guide](docs/protocol-rollout.md#push-to-main-deployment) for
first-release staging/backup requirements, exact configuration, and rollback.

---

## What's indexed

The original Bitcoin views cover the following envelope families. The opt-in
protocol extension is pinned to Tacit `7a917a8e`; see
[coverage and rollout](docs/protocol-rollout.md) for current families, chain
indexing, validation boundaries, and deployment instructions.

| opcode      | hex   | shown                                             |
| ----------- | ----- | ------------------------------------------------- |
| `CETCH`     | 0x21  | new asset, hidden supply                          |
| `CXFER`     | 0x23  | confidential transfer                             |
| `T_MINT`    | 0x24  | issuer mint (hidden amount)                       |
| `T_BURN`    | 0x25  | burn (amount public)                              |
| `T_AXFER`   | 0x26  | atomic OTC settlement                             |
| `T_PETCH`   | 0x27  | fair-launch deployment                            |
| `T_PMINT`   | 0x28  | permissionless mint (amount + blinding public)    |
| `T_DEPOSIT` | 0x29  | mixer deposit / `POOL_INIT`                       |
| `T_WITHDRAW`| 0x2A  | mixer withdrawal                                  |

Page set:

- `/` — recent envelopes feed + protocol stats
- `/assets` — directory of every CETCH/T_PETCH ever observed
- `/assets/:id` — per-asset card with mints, burns, transfers, cap progress
- `/tx/:txid` — full envelope decode for a single tx
- `/utxo/:txid/:vout` — single confidential UTXO with its parent envelope
- `/api/search`, `/api/feed` — JSON endpoints used by the islands

---

## Protocol extensions

- `/protocol` reports index checkpoints, reference freshness and the parity readiness gate.
- `/protocol/activity`, `/protocol/assets`, `/protocol/pools`, `/protocol/farms`,
  `/protocol/bridge`, `/protocol/collateral`, `/protocol/secret-sats`, `/protocol/locks` expose public
  protocol observations and sourced state.
- `/protocol/tx/:chain/:txid` displays every indexed envelope or contract log.
- `/airdrop/ethereum` verifies published Ethereum allocations and optionally reads
  current claim status. `/airdrop` preserves the historical Bitcoin snapshot.

New indexers and navigation default to disabled. Decoding is not proof validation;
reference snapshots are labelled with provenance. The existing mint validators
check only their documented predicates. No hidden amounts or ownership are inferred.

Run `node scripts/sync-protocol.mjs --check` from the repository root to check
shared schema/operation definitions. Deployment and replay are explicit operational
steps; see [the runbook](docs/protocol-rollout.md).

## Asset images and page performance

IPFS media resolution follows the Filebase mirror and public gateway fallbacks
used by Tacit (image behavior reviewed at `9da3b159`). Old
`content.wrappr.wtf` URLs normalize to Filebase immediately; the background
resolver retries failures and repairs obsolete stored URLs. Metadata with no
image uses the asset identicon. The frontend loads off-chain metadata and
unresolved images asynchronously through `/api/asset-metadata?asset=ASSET_ID`.
Server fetches accept IPFS content only, bound response size and time, and never
follow arbitrary metadata-selected hosts. Direct HTTPS image URLs still render
in the browser. Metadata requires JavaScript; on-chain fields remain server rendered.

The frontend uses at most four database connections. Homepage data caches for
10 seconds, duplicate tickers for 30 seconds, and successful media lookups for
one hour (HTTP media responses cache for five minutes). Concurrent cache misses
share one load. Recent block counts query only the displayed blocks. Chain-tip
refreshes no longer hold a page render for the remote timeout. These caches can
introduce their stated display delays; readiness and validation results are not
included in the homepage cache. No extra service or compute plan is introduced.
