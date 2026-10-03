# Protocol parity upgrade and rollout

Target: Tacit `7a917a8ec4dad72210351d80bcbf269073ac790d` (2026-09-29).
The changes are local. Nothing has been pushed, deployed, migrated or replayed
against production. **Operational parity is not yet established.** A clean build
is not evidence that the migration, historical replay or consensus adapters work
on the deployed data.

## Implemented coverage

| Area | Implementation |
| --- | --- |
| Bitcoin wire formats | Current AMM, LP, farms, bids, BP+ atomic/bound transfers, bridge burn, cross-out, cBTC, calls and per-input Secret Sats envelopes. Historical formats and reserved/experimental operations retain explicit labels and raw bytes. |
| Existing correctness | Current 161-byte `0x2b` discrimination, BP+ commitment persistence, variable trade signature/output order, expanded transfer queries, unsigned-value fallback and exact cap arithmetic. |
| Canonical Bitcoin state | Private, pinned upstream worker replay with transactional Postgres KV, one writer lease, epoch-based rebuild on Bitcoin or Ethereum reorg, complete state-change journal, canonical asset/PETCH registry, mint progress, AMM reserves, LP assets, farms and bond receipts. |
| Output acceptance | Pinned upstream ancestry/kernel/range-proof validator behind a private read API. Decisions carry source revision, epoch, block hash, checked time and note commitment. Missing dependencies retry; they do not become rejections. Decisions are refreshed, and epoch changes invalidate old decisions. |
| Bitcoin Secret Sats | Pinned upstream authenticated replay and Halo2 verifier; complete notes, nullifiers, exits and per-input acceptance records published as an atomic snapshot generation. Leaf zero is included. The verifier checks its key, parameters and Wasm against upstream pins. |
| Ethereum V1 | Full public-value decoding of successful `settle` and `createPairAndSettle` calls, including nested router/helper calls. Full-block call tracing discovers public AMM/create-pair operations without watched logs. Reverted calls never produce accepted effects. |
| Public EVM state | Pinned deployment events, dynamically discovered canonical factory tokens, exact mint/burn totals reconciled with opening supply and `totalSupply`, AMM reserves/LP shares, cBTC backing, CDP debt/rate/savings/fee gauges and generation retirement. |
| EVM accumulators | Independent note, lock and CDP leaf sequences. Keccak roots/counts reconcile to contract state at one block. Lock memos attach only when an accepted call matches unambiguously. CDP/lock/nullifier namespaces stay separate. |
| EVM Secret Sats | Ethereum, Base and Robinhood pool/router events, public flows, memos, nullifiers and roots. Both reserved leaf positions are retained, including zero padding. Event roots/counts reconcile to contract state. |
| Cross-chain state | Source-specific bridge-burn identifiers; cross-out claims; cBTC outpoint keys linking locks, escrow, mint and redeem records; call/message counterparts. Reflection digest/tip/counters come from contract reads. The private worker scans finalized cross-outs before evaluating Bitcoin claims and revisits pending claims. |
| UI | Opt-in protocol directories, public identifier/address search, accepted state/effects, notes/locks/CDPs, transaction details, output evidence, checkpoint freshness and readiness. Existing Bitcoin URLs remain. Ethereum airdrop allocation/proof/claim lookup is separate from the historical Bitcoin snapshot. |
| Recovery | Atomic block/cursor writes, canonical reorg cleanup, versioned coverage windows, bounded Bitcoin repair and explicit EVM tail repair. Unavailable data preserves the last successful snapshot with an error/freshness indicator. |

## Authority and scope

Acceptance is attributed to the **pinned upstream replay**, rather than to the
structural decoder. EVM acceptance is evidenced by canonical contract events and
successful call traces; the explorer does not rerun the SP1/Groth16 verifier.
Canonical EVM queries and the upstream cross-out accelerator trust their configured
RPCs. Bitcoin pool replay performs the upstream header/proof checks. Source revision
and checksums are retained with generated inputs and runtime state.

The explorer shows public protocol state. It does not infer private amounts,
secret ownership, or a note-to-nullifier association. Transparent output validity
is a decision at the recorded canonical view/time; an accepted output is not a
claim that it remains spendable. Ordinary Bitcoin consumption is tracked separately. Public transparent-note
nullifiers also link Ethereum fast-lane consumption where the source fields
determine that identifier; private pool leaves are never deanonymized.
Wrapped/public/confidential/bridged domains are not added together into an invented
cross-chain circulating supply. LP total shares and public mint cap progress are
shown in their own units.

The current deployment manifest is the scope for EVM generations. A nonzero
successor blocks readiness until that deployment, ABI and historical coverage are
reviewed. Retired deployment history requires its own reviewed manifest/ABI; do
not apply the current ABI to old generations by assumption.

**Upstream limitation:** the source implements aggregate opcode `0x6e`, but the
pinned proof configuration has no aggregate verification key and the normative
spec still disagrees with activation. Bytes are preserved as an unverified
extension. Encountering an aggregate blocks complete readiness; no fabricated key,
acceptance result or silent skip is provided.

Legacy signed bigint columns are retained to avoid a disruptive live-table type
rewrite. Larger exact values remain available in protocol JSON/raw payloads;
legacy rows are labelled `extended` and are excluded from incompatible legacy totals.
The original assessment is retained as the historical gap list, not as a report
of current implementation status.

## Push-to-main deployment

`render.yaml` retains the existing frontend, indexer worker and explorer database.
The worker uses `runtime/Dockerfile.worker` to run three supervised processes:
indexer rollout, canonical replay and pool verification. The adapters bind only
to localhost. Canonical state is isolated in the `tacitscan_canonical` schema in
the existing database; pool SQLite persists on the worker's 10 GB disk. No extra
Render service or database is declared. Worker compute and disk charges change.
Frontend and worker deployments remain independent.

### One-time Render setup before the first push

1. Confirm the existing services belong to this repository's Render Blueprint,
   linked to `main`, with **Auto Sync enabled**. Service auto-deploy by itself
   does not create the new resources declared in the Blueprint.
2. Create an environment group named **`tacitscan-parity-secrets`** in the same
   workspace/environment. Connect it to `tacitscan-indexer` only. Add these server-only values (the names match the local `.env`):

   | Key | Required value |
   | --- | --- |
   | `RPC_ETH` | Ethereum archive/read RPC supporting historical `callTracer` |
   | `RPC_BASE` | Base historical read RPC |
   | `RPC_ROBINHOOD` | Robinhood Chain historical read RPC |
   | `BTC_POOL_CHECKPOINT` | Reviewed `height:hash` at or before 948241, meeting upstream header replay requirements |

   The application accepts these aliases and the original `EVM_RPC_URL_*` names.
   Local `.env` files are ignored by Git and are not uploaded to Render: copy the
   values into the named environment group before syncing. The Blueprint references this existing group; it does not manage or overwrite
   its secret values. Existing Blueprint updates do not prompt for new
   `sync: false` values, so an explicit group avoids silently missing credentials.
3. Complete the staging procedure below and retain a recoverable production
   database backup before the first production replay. Automatic startup repair
   updates historical legacy rows as well as additive protocol tables.

### What the push does

- The frontend receives `RPC_ETH` from the existing worker. The worker hosts both
  replay adapters on localhost; no private service hostname is required.
- The worker disk enforces stop-before-start deployment and retains pool SQLite.
  The supervisor stops the entire worker if any child process exits, so the
  platform restarts them together. Do not increase writer instance counts.
- `dist/rollout.js` checks configuration, obtains a writer lease, runs additive
  migrations, freezes the existing Bitcoin cursor as a repair boundary and runs
  resumable historical replay from `START_HEIGHT`. Restarts keep the same boundary.
  It then starts normal Bitcoin/EVM/reference/validation loops. Fresh databases
  start ordinary ingestion directly. EVM and replay adapters catch up independently.
- The frontend keeps its ordinary health endpoint and existing routes. Protocol
  status remains visible during catch-up. With `PARITY_REQUIRE_READY=true`,
  protocol data queries return a pending message until the readiness report is
  fresh, error-free and matches the frontend's protocol revision and decoder.
  Missing tables, failed reconciliation and stale reports keep that gate closed.
  The gate re-closes if readiness is subsequently lost.

Historical replay pauses new Bitcoin indexing until it finishes; existing pages
remain readable but their latest height can lag. Replay adapters restart with the worker on redeploy. No claim of instantaneous full parity is made.
Subsequent pushes use the same deployment path; changing protocol scope still
requires reviewed migrations, replay coverage and staging evidence.

Render references: [Blueprints](https://render.com/docs/infrastructure-as-code),
[secret and service wiring](https://render.com/docs/blueprint-spec),
[exclusive disk deployments](https://render.com/docs/disks).

Render supports changing the existing worker runtime through Blueprint sync;
see [runtime changes](https://render.com/docs/native-runtimes#changing-a-services-runtime).
Verify the combined worker memory under replay load before production; the
configured plan is a starting point, not a measured capacity guarantee.

## Required staging infrastructure

- Node 24, Postgres for a **staging clone** of the explorer database.
- A staging clone with a separate canonical schema and a staging SQLite volume.
  Staging data must not share the live database or live disk. Budget disk for historical
  journal rows, snapshot generations and archived epochs; these are not pruned
  automatically. Budget additional memory/CPU for proof verification.
- Bitcoin RPC/Esplora access and a reviewed `BTC_POOL_CHECKPOINT=height:hash`
  meeting the upstream header replay's start/checkpoint constraints.
- Read RPCs for Ethereum (1), Base (8453) and Robinhood Chain (4663).
  All need historical logs, blocks and `eth_call`. Ethereum additionally needs
  historical storage and `debug_traceBlockByNumber` with Geth `callTracer`;
  `debug_traceTransaction` is the fallback for individual calls. Ethereum trace
  windows are eight blocks to bound memory. A provider limited to logs is
  insufficient for full public-AMM coverage.
- A read Ethereum RPC for the private canonical worker's finalized cross-out
  scan (`ETHEREUM_RPC_URL`; Sepolia when using Bitcoin signet).

No wallet, relayer, transaction sender or signing key belongs in these services.
Their HTTP ports bind to loopback in Compose. Keep them on a private network if
running the explorer elsewhere; the adapters are not public hosted APIs.

## Staging procedure

1. Back up production and create a staging clone. Keep production auto-deploy
   untouched until staging is accepted: `render.yaml` currently has
   `autoDeployTrigger: commit`. Do not push the production branch as a staging mechanism.
2. Build the indexer and run `pnpm db:migrate` **against the clone**. New migrations
   `0012`–`0014` add sidecar tables, views and coverage/validation metadata. Each
   migration and history marker commit under an advisory lock with a five-second
   lock timeout. Startup stops if migration fails.
3. Copy `runtime/.env.example` to a private, ignored env file and fill the password,
   Ethereum read RPC and reviewed Bitcoin checkpoint. From the repository root:

   ```sh
   docker compose --env-file runtime/.env -f runtime/compose.yaml build
   docker compose --env-file runtime/.env -f runtime/compose.yaml up -d
   ```

   Images fetch the exact detached upstream commit. The proof/SQLite image uses
   Node 22; the application and canonical worker use Node 24. Worker, server and relay dependencies use the reviewed exact runtime lockfiles.
   Services refuse a different source HEAD. Default Bitcoin start is 948241;
   align start/depth/network with the explorer. The pool's inclusive confirmation
   count is adjusted to match the explorer's `tip - depth` checkpoint.
4. Configure these **staging indexer** variables:

   ```dotenv
   PARITY_INDEXING_ENABLED=true
   EVM_INDEXING_ENABLED=true
   EVM_REQUIRE_CALL_TRACES=true
   REFERENCE_INDEXING_ENABLED=true
   ACCEPTED_STATE_ENABLED=true
   TACIT_REFERENCE_URL=http://127.0.0.1:8787
   BTC_POOL_REFERENCE_URL=http://127.0.0.1:8788
   ```

   Set `EVM_RPC_URL_1`, `_8453`, `_4663` as server-only secrets/configuration.
   Adjust the private URLs when services run on different hosts. Readiness will
   remain false while replay, validation or required references are incomplete.
5. Stop the staging Bitcoin worker. Record its existing cursor and preview a
   historical repair, replacing `END_HEIGHT` with that recorded height:

   ```sh
   pnpm replay --from 948241 --to END_HEIGHT
   pnpm replay --from 948241 --to END_HEIGHT --apply
   ```

   Without `--apply` the command prints a plan. It repairs legacy rows and modern
   observations, including later-input envelopes, without advancing the live
   cursor. Repeating the same range resumes its versioned checkpoint. A changed
   checkpoint hash stops it. Restart the ordinary worker after repair.
6. New EVM indexes replay automatically from their pinned starts. If a staging
   index already ran without traces or with older coverage, stop its EVM worker
   and explicitly repair its tail, e.g.:

   ```sh
   pnpm replay:evm --chain 1 --from 25998736
   pnpm replay:evm --chain 1 --from 25998736 --apply
   ```

   The range begins at the containing coverage window and ends at the saved cursor.
   Applying it deletes/rebuilds **derived EVM rows** in that tail; it never touches
   Bitcoin rows. On interruption the normal worker resumes the rewound cursor.
7. Enable `PARITY_UI_ENABLED=true` on staging. Review existing routes and new
   protocol pages. Complete a verification pass covering
   the assessment's fixtures, unsigned amounts, interrupted replay, reorgs,
   unavailable providers, nested/reverted calls and migration rollback.
8. Run the read-only data gate against staging:

   ```sh
   pnpm parity:check
   ```

   It exits nonzero until required flags, continuous revision/decoder coverage,
   canonical/fresh checkpoints, complete validation, supported encodings and
   tree and public-token supply reconciliations pass. `/protocol` displays the published report;
   `/api/protocol?view=readiness` returns 503 when absent, stale or failing.
   The gate does **not** substitute for migration/regression verification.
9. Only after staging acceptance should a production push/cutover be considered.
   Schedule worker maintenance and retain backups. The production Blueprint
   automates migrations, replay and readiness activation after the one-time
   setup above; it does not create the pre-release backup. Do not run this
   repository's commands against an unreviewed `DATABASE_URL`.

## Local checks and remaining evidence

Indexer TypeScript build, frontend Astro typecheck/production build, runtime
JavaScript syntax checks, generated-file comparison and whitespace review are
local checks. RPC capability checks and isolated temporary database migration checks passed.
No container execution, staging migration,
historical replay or real-chain reconciliation have been run for this upgrade.
Until those staging results exist, **do not report full operational parity or
push the upgrade**.

## Rollback

Set `AUTO_PROTOCOL_REPLAY=false` and disable `PARITY_UI_ENABLED`, `ACCEPTED_STATE_ENABLED`, `EVM_INDEXING_ENABLED`,
`REFERENCE_INDEXING_ENABLED` and `PARITY_INDEXING_ENABLED`; restart the relevant
services. Leave additive tables and private replay volumes intact for diagnosis.
Canonical Bitcoin rewinds also clean sidecar state while ingestion is disabled.
Existing URLs continue using their original tables. Code rollback does not undo
legacy rows changed by historical repair: restore/reconcile from the pre-replay
backup on a clone before making live changes.

Blueprint sync will restore its declared flags on a later push. Commit rollback
configuration changes (including the replay flag), or pause Blueprint Auto Sync
before applying emergency dashboard overrides.

## Reproduce vendored inputs

```sh
node scripts/vendor-protocol.mjs ../tacit
node scripts/vendor-evm.mjs ../tacit
node scripts/sync-protocol.mjs
```

Both generators require the exact upstream commit. Solidity/decoder source hashes,
the reviewed deployment manifest and the upstream MIT license are retained.
Inherited engine ownership events follow [Solady's public event interface](https://github.com/Vectorized/solady/blob/main/src/auth/Ownable.sol).
Review every source/ABI/deployment difference when changing the pin. Keccak tree
storage slots are specific to the pinned pool layout and must be reviewed with it.
