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
Verification of rangeproofs and Schnorr signatures is intentionally
**not** done at index time — explorers store and present, they don't gate
spending. A future job can batch-verify in the background if you want
that signal in the UI.

The frontend is Astro SSR. Pages query Postgres directly via Drizzle and
ship as static-feeling HTML. Two interactive bits — the search bar and
the live recent-envelopes feed — are vanilla `<script>` islands.

---

## Local development

You need:

- Node 20+
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

Everything runs on **Render** from a single `render.yaml` Blueprint:
the frontend (Astro SSR web service), the indexer (worker), and a managed
Postgres they share.

1. New Render **Blueprint** → point it at this repo. It provisions all three:
   `tacitscan-db` (Postgres), `tacitscan-frontend` (web), `tacitscan-indexer`
   (worker). `DATABASE_URL` is wired into both services from the DB
   automatically — no secret to copy.
2. When prompted, set the one `sync: false` secret:
   - `BITCOIN_RPC_URL` — a dRPC URL. This is the primary/fast path: backfills
     the ~8k-block Tacit range in ~1–3 h (one `getblock` per block). Leave it
     blank to run on the free Esplora endpoints (mempool.space / blockstream)
     instead — correct, but ~1–2 days.
3. Apply. The frontend binds Render's `PORT`; the indexer runs migrations then
   the block walker (`pnpm start`).

**Adding services requires re-syncing the Blueprint** — plain `git push`
autoDeploys *existing* services but won't create the new DB/worker or pick up
new env vars. Open the Blueprint in Render and "Apply" once after this change.

Managed Postgres (`tacitscan-db`) is `basic-256mb`; the Tacit-only dataset is
well under 1 GB. Bump the plan in the Blueprint if you outgrow it.

---

## What's indexed

Every Tacit envelope opcode defined in
[SPEC.md §5](https://github.com/z0r0z/tacit/blob/main/SPEC.md):

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

## Tradeoffs you may want to revisit

- **No verification at index time.** Saves CPU and avoids needing a JS
  bulletproof library. If you want a "valid ✓" badge on each envelope,
  add a worker that batch-verifies and writes a `verified_at` column.
- **Esplora as RPC.** Public mempool.space and blockstream.info are free
  but rate-limited. For heavy backfill, swap in a paid Esplora endpoint
  (QuickNode, GetBlock) by changing `ESPLORA_URL`.
- **Schema duplicated across two subdirs.** Pragmatic given the brief
  asked for two clean subdirs. Promote to a pnpm workspace shared package
  if drift becomes a problem.
- **Tip-only reorg handling.** We index at depth `CONFIRMATION_DEPTH=3`
  and walk back one block on parent-hash mismatch. Reorgs deeper than
  this depth would require richer chain-tracking and are out of v1 scope.
- **No mempool view.** Only confirmed envelopes are surfaced.
