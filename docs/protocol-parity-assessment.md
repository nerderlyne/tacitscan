# Tacitscan protocol parity assessment

Assessment date: 2026-09-29.

Historical assessment, written before implementation. For the local implementation and remaining staging gates, see [protocol rollout](protocol-rollout.md).

Compared Tacitscan `886b280` (2026-07-03), including the existing working-tree changes, with the clean local Tacit checkout at `../tacit`, commit `7a917a8e` (2026-09-29). The protocol lives at `~/code/tacit`; `~/code/tacitscan` is the explorer. The upstream GitHub README was also checked. Deployment details below are the checkout's published deployment records, not independently queried live balances or contract verification results.

This is a source review and implementation plan. No application code, database, or deployed services were changed; no tests were run. Existing edits to the homepage, queries, and blocks page were preserved.

## Assessment

Tacitscan needs changes to decoding, persistence, state validation, and chain coverage. Adding opcode names alone will not reach parity. The existing explorer covers early Bitcoin issuance, transfers, and several legacy constructions. Current Tacit also has Bitcoin AMMs/farms, deployment-bound notes, bid settlement, cBTC locks, two-way reflection, an Ethereum confidential DeFi pool, and Bitcoin/EVM Secret Sats pools.

There are immediate correctness gaps in otherwise supported activity:

- Current Bitcoin bridge burns use a 161-byte `0x2B` envelope. Tacitscan routes every `0x2B` into the legacy `T_DROP` decoder. Its `T_BRIDGE_BURN` name instead means the old `0x61` tETH bridge format.
- `T_CXFER_BPP` is decoded but its output commitments are never persisted. Asset transfer queries and the asset-page counter omit it too.
- Secret Sats spends may occupy multiple inputs of one Bitcoin transaction. Tacitscan only inspects `vin[0]` and uses `txid` as the envelope primary key.
- Three opcodes presented as cBTC.tac operations (`0x49`, `0x4B`, `0x4F`) are reserved in the current normative spec. Decoding their historical byte shapes must not imply current protocol acceptance.

Existing infrastructure worth retaining: RPC/Esplora failover, raw envelope bytes, mempool ingestion, a block ledger with bounded reorg walkback, address activity, PMINT commitment/window checks, MINT issuer-signature checks, and issuer-published supply metadata. README claims about no mempool, no verification, and tip-only reorg handling are stale.

Sources: [current spec](../../tacit/SPEC.md), [deployment records](../../tacit/docs/DEPLOYMENTS.md), [decoder](../indexer/src/envelope.ts), [handlers](../indexer/src/handlers.ts), [queries](../frontend/src/lib/queries.ts).

## 1. Bitcoin opcode coverage

| Area | Current protocol | Tacitscan today | Required work |
| --- | --- | --- | --- |
| Issuance and ordinary transfers | `0x21–0x28`, including BP+ at `0x22` | Core shapes decoded; only partial cryptographic validation | Retain historical BP support; finish BP+ output persistence; validate ancestry, kernels, range proofs, and output layouts before claiming accepted state |
| Deployment-bound transfer | `T_CXFER_BOUND` `0x39` | Unknown | Decode binding plus BP+ transfer body; persist outputs and target deployment |
| BP+ atomic trades | `T_AXFER_BPP` `0x3C` | Unknown | Decode, validate asset-input roles, and persist outputs; include in activity/counts |
| Bitcoin AMM | `T_LP_ADD` `0x2D`, `T_LP_REMOVE` `0x2E`, `T_SWAP_BATCH` `0x2F`, `T_PROTOCOL_FEE_CLAIM` `0x31`, `T_SWAP_VAR` `0x32`, `T_SWAP_ROUTE` `0x33` | Unknown; no pool state | Decode variants, materialize accepted reserves/LP supply/fees, index route legs and batch outcomes |
| Bitcoin farms | `T_FARM_INIT` `0x34`, `T_LP_BOND` `0x35`, `T_LP_UNBOND` `0x36`, `T_LP_HARVEST` `0x3B`, `T_FARM_REFUND` `0x3E` | Unknown; no farm state | Track programs, treasuries, receipts, reward accrual, harvests, and refunds |
| Buyer-offline bids | `T_PREAUTH_BID` `0x5B`, `_VAR` `0x5C` | Unknown | Decode settlement and payment/refund layout; distinguish on-chain fills from off-chain orders. Upstream validators are implemented, while wallet builders are gated |
| Current bridge burn | `0x2B`, exactly 161 bytes | Parsed as legacy `T_DROP` | Apply current format discrimination, persist burn/nullifier/destination/binding identifiers, and use a distinct semantic name from legacy `0x61` |
| Return from Ethereum | `T_CROSSOUT_MINT` `0x65` | Unknown | Decode cross-out claim and note, verify reflected acceptance, and persist the resulting Bitcoin output |
| Current cBTC | `T_CBTC_LOCK` `0x66`, `T_CBTC_REDEEM` `0x67` | Unknown; old slots/lien formats are the only cBTC coverage | Track lock outpoints, backing sats, spends/redeems, and corresponding Ethereum mint/escrow lifecycle |
| Cross-chain calls | `T_BTC_CALL` `0x68`, `T_ETH_CALL` `0x69` | Unknown | Decode public messages and link authorization/reflection/execution; a message is not a value transfer |
| Bitcoin Secret Sats | `T_BTC_SHIELD` `0x6C`, `T_BTC_SPEND` `0x6D` | Unknown; later-input spends missed entirely | Scan permitted input positions, store multiple envelopes, index accepted leaves/nullifiers/roots/exits, and verify pinned Halo2 and boundary proofs |
| Legacy/recovery | Mixer `0x29–0x2A`, drop/claim `0x2B–0x2C`, variable atomic trades `0x37/0x3D`, attestation `0x38`, slots `0x43–0x47`, early bridge `0x60–0x64` | Partial decoding; some persistence is only skeletal; `0x3D/0x64` absent | Preserve historical visibility with explicit legacy labels. Variable atomic-trade builders are off and reflection does not fold them |
| Reserved formats | Includes `0x49–0x4C`, `0x4F`, `0x57–0x5A` | `0x49/0x4B/0x4F` decoded and described as operations | Retain raw/historical interpretation, but do not credit current state or advertise them as live features |

**Upstream discrepancy to resolve during implementation:** `worker/src/btc-shielded-pool.js` implements `T_BTC_AGG = 0x6E`, and the pool indexer has aggregate-proof processing. SPEC §3.9 still calls `0x6E` free. The checked-in `dapp/btc-pool/pin.json` has no aggregate key; the verifier says it halts on aggregate carriers without that key. Preserve and identify these bytes as implementation-defined/unverified until the specification and deployment pin are reconciled. Do not infer production activation from a decoder constant.

Sources: [SPEC §§3, 10](../../tacit/SPEC.md), [pool parser/replay](../../tacit/worker/src/btc-shielded-pool.js), [aggregate verifier](../../tacit/worker-relay/src/lib/btc-pool-verify.js), [proof pin](../../tacit/dapp/btc-pool/pin.json).

## 2. Repair existing persistence and accounting first

1. **Persist BP+ outputs.** `persistTCxferBpp` only writes an envelope. Reuse the ordinary transfer output persistence and backfill `(txid, vout)` commitments. `/utxo` currently returns 404 for these missing rows. Complete output mappings for other supported output-producing operations, including interleaved atomic-trade layouts.
2. **Fix transfer queries and counters.** `getAssetTransfers` and `assets/[id].astro` only count `CXFER` and `T_AXFER`. Use a shared operation classification covering BP+, bound transfers, and relevant trade variants. Apply consistent canonical-chain and acceptance filters to asset activity and totals.
3. **Separate parse success from protocol acceptance.** `status = 'ok'` currently means successful decoding. Add independent decode, validation, chain, and reflection states, plus reason, validator version, and evidence source. Unknown-to-this-explorer must not be described as necessarily undefined by the protocol.
4. **Complete validation where the UI claims validity.** PMINT checks and MINT issuer-signature verification already exist, but are not a full ledger validator. Kernels, range proofs, ancestry, spent inputs, pool roots/nullifiers, and stateful caps/AMM/farm rules determine accepted state. Prefer shared upstream validation over a second hand-maintained implementation.
5. **Treat missing dependencies as pending.** The MINT validator currently persists failed transaction fetches as invalid. Use retryable/pending states for missing chain data or verifier availability. Reorgs must invalidate cached parent facts and dependent validation results.
6. **Track consumption beyond Tacit-bearing transactions.** The block walker skips ordinary Bitcoin transactions before persistence. They can spend Tacit outputs and destroy value. For spendability/supply claims, record every spend of a tracked outpoint, plus reflected Ethereum consumption of bound notes; a commitment row alone is not an unspent note.

Sources: [BP+ handler](../indexer/src/handlers.ts), [mint validator](../indexer/src/mint-validator.ts), [block walker](../indexer/src/indexer.ts), [format descriptions](../frontend/src/lib/format.ts), [asset page](../frontend/src/pages/assets/[id].astro), [validity rules](../../tacit/SPEC.md).

## 3. Extend the database around the actual protocol entities

- **Transactions and envelopes:** separate the transaction from its envelopes; use `(network, txid, input_index)` or an equivalent stable envelope ID. Preserve input order, envelope bytes, carrier inputs/outputs, and commit outpoint. Keep `/tx/:txid` as a transaction page listing all envelopes.
- **Networks and deployments:** scope Bitcoin data by network and EVM data by `(chain_id, contract_address, generation)`. Current asset/envelope/commitment primary keys omit network, and many frontend queries are global despite `PUBLIC_NETWORK`. Add per-chain cursors and canonical block identities.
- **Assets:** support Bitcoin etches, reflected assets, Ethereum escrow tokens, pool-minted cBTC/cUSD, and LP/reward assets. Existing rows require a Bitcoin etch and cannot represent assets with no such genesis. Add origin, metadata source, token contract, canonical ID, note decimals, ERC20 decimals, and `unitScale`.
- **Amount types:** use exact numeric/decimal-string storage for unsigned 64-bit note values and uint256 EVM values. PostgreSQL signed BIGINT does not cover all protocol u64 values. Avoid Number conversions in amounts, cap calculations, and airdrop allocations.
- **State tables:** add outpoint spends, accepted outputs, pools/reserve history, farm programs/receipts, bridge burns/cross-outs, cBTC locks/escrows, CDPs, notes/nullifiers/roots, and settlement/event records. Separate state by pool family and deployment.
- **Proof provenance:** record proof system/key/version, accepted/rejected/pending status, checkpoint/block/root, and whether state was locally derived or obtained from an upstream index.
- **Reorgs:** existing rewind only marks envelopes orphaned and deletes block rows. Rebuild or undo dependent assets, commitments, validation, and all newly materialized state. Do not apply orphaned AMM/farm updates to subsequent blocks.

Use one shared schema and opcode registry for the indexer/frontend. Their independent copies and repeated dispatch/mapping code currently make drift easy.

Sources: [indexer schema](../indexer/src/schema.ts), [frontend schema](../frontend/src/schema.ts), [rewind implementation](../indexer/src/indexer.ts), [asset units and IDs, SPEC §4.2](../../tacit/SPEC.md).

## 4. Add Ethereum confidential-pool and reflection indexing

The published V1 Ethereum deployment starts at block **25,998,736**, pool `0x000000000Ed1eabD231Be41d93b719056F7febFC`. Load deployment addresses from `contracts/deployments/1-createx.json`, `1.json`, and generated configuration; the CreateX manifest alone does not contain every periphery deployment. Preserve deployment lineage and predecessor/successor history.

Required coverage:

- Pool registrations, wraps, note/lock leaves and encrypted memos, nullifier spends, cross-outs, Bitcoin-note consumption, CDP insertions, and generation retirement.
- Settlement receipts and public values. SPEC §5.3 defines operations 0–34; op 5 is reserved. Cover observable public effects for transfers, wraps/unwraps, AMM/LP activity, OTC/bids, adaptor/stealth locks, CDPs, cBTC, farms, and fused operations. Do not promise per-user amounts or operation details that are absent from public data.
- CollateralEngine escrow and CDP lifecycle; FarmManager/wTAC rewards; canonical ERC20 mint/burn and public AMM activity where relevant to protocol totals.
- Bridge progress: Bitcoin observed → sufficiently buried → reflected/attested → minted or consumed; reverse cross-out → proven Ethereum state → accepted Bitcoin re-mint. Link public burn IDs, claim IDs, commitments, and transaction hashes only where the protocol exposes a relation.
- Distinguish Bitcoin confirmation depth from reflection eligibility: reflection requires **24** confirmations in the published deployment, independently of the explorer's near-tip feed. The reflection seed at Bitcoin height **967040** is not a replacement for the earlier asset-history scan.
- Health: separate Bitcoin scan height, EVM scan height, accepted-state height, reflected height, proof availability, and pending settlements. Report stale data with an as-of block/time.

Reuse candidates: `dapp/confidential-evm-log.js`, `dapp/confidential-indexer.js`, `dapp/confidential-lock-scan.js`, and `worker/src/confidential-index.js`. The latter already handles multiple/nested settles and corroborates them against successful events; calldata alone does not prove a nested settle succeeded. `GET /confidential/index` can accelerate initial coverage if its provenance and lag are explicit, with event/root reconciliation for independently verified results.

Sources: [deployments](../../tacit/docs/DEPLOYMENTS.md), [pool events](../../tacit/contracts/src/ConfidentialPool.sol), [public index implementation](../../tacit/worker/src/confidential-index.js), [reflection rules](../../tacit/SPEC.md).

## 5. Add Secret Sats coverage as distinct pool families

**Bitcoin pool:** mainnet experimental, with TAC offered by the dapp; signet also supported. It holds Tacit assets, not native BTC. Present shields, spends, optional exits/wants, accepted leaves, nullifiers, roots, carrier input order, and proof status. Reuse `worker/src/btc-shielded-pool.js` plus `worker-relay/src/btc-pool-indexer.js` and its chain/verifier/store modules, or ingest their public read endpoints with stated provenance. These implement authenticated block checks, proof verification, and rollback that a byte decoder does not supply. Never infer a hidden note's owner or connect a nullifier to a note without public evidence.

**EVM pool:** separate from the SP1 ConfidentialPool, with its own Groth16 proof system and `Transact` event. The deployment manifest lists the same pool address, `0x000000c2A20657CE25f2Ba99737933D031AFBEE9`, on:

| Chain | Chain ID | Pool deploy block |
| --- | --- | --- |
| Ethereum | 1 | 26,069,245 |
| Base | 8453 | 51,864,014 |
| Robinhood Chain | 4663 | 73,991,661 |

Index public deposits/withdrawals, commitments/nullifiers, roots, fees, and router effects. A move between this pool and V1 is a public exit/entry, not a shared note tree. Use `contracts/deployments/evm-pool.json` for configuration. Secret Sats Join/silent payments are an adjacent Bitcoin payment surface; generic Bitcoin transaction visibility or explicitly sourced join metadata can be added separately, without treating arbitrary joins as Tacit asset envelopes.

Sources: [Bitcoin pool indexer](../../tacit/worker-relay/src/btc-pool-indexer.js), [EVM pool guide](../../tacit/docs/EVM-POOL.md), [manifest](../../tacit/contracts/deployments/evm-pool.json), [EVM event](../../tacit/contracts/src/TacitEvmPool.sol).

## 6. Explorer pages and airdrop changes

| Surface | Update |
| --- | --- |
| Home/activity | Chain/pool-family filters, all supported operation categories, separate observed/accepted counts, freshness indicators |
| Transaction | All Bitcoin input envelopes or EVM logs/settlement effects; parse/validation/confirmation/reflection status; proof-system-specific labels; linked public cross-chain steps |
| Asset | Unified canonical identity, chain representations and unit scales, BP+ activity, LP/pool-minted assets, disclosed versus verified supply, public burned/locked/bridged quantities without double counting |
| UTXO | Actual output mappings, protocol acceptance, Bitcoin spend and reflected-consumption state |
| Pools/farms | New directories/detail pages for Bitcoin and EVM pools; public reserves, liquidity/fees, reward programs and receipt lifecycle |
| Bridge/cBTC/CDPs | Transfer progress and reflected roots; lock/backing/escrow state; public debt/collateral and liquidation history |
| Secret Sats | Pool-specific activity/roots/proof status; no public private-balance lookup |
| Search | Chain-qualified Bitcoin/EVM transactions, token/contract addresses, assets, pool IDs, and public claim/lock identifiers |
| Airdrop | Label the existing Bitcoin snapshot/fulfilment pages explicitly; add the current Ethereum TAC distributor using its published Merkle allocations and on-chain claimed/paused/deadline state |

The airdrop distinction matters: `frontend/src/lib/airdrop.ts` computes a floating-point 1:1 ZAMM+ZORG snapshot sum from May. The current Ethereum distributor is a **separate** allocation at `0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8`, documented as 8,652 recipients and 999,999 TAC. Do not replace its Merkle allocations with the old CSV calculation or erase the historical Bitcoin distribution. The existing issuer-supply metadata display can remain, with cryptographic verification recorded separately from publication.

Sources: [airdrop helper](../frontend/src/lib/airdrop.ts), [current airdrop guide](../../tacit/docs/AIRDROP.md), [allocation build](../../tacit/airdrop/v1/README.md), [supply metadata](../frontend/src/lib/etch-metadata.ts).

## 7. Backfill and rollout order

**P0 — Correct the existing explorer.** Pin a reviewed upstream revision; establish a shared operation registry; distinguish current bridge burns and legacy/reserved operations; persist BP+ outputs; fix counters and validity descriptions; correct airdrop labeling. Add decoder/validator versioning before replay.

**P1 — Reach Bitcoin explorer parity.** Migrate to multiple envelopes per transaction and richer asset/state records. Add active Bitcoin opcode families, validated output consumption, AMM/farm materialization, current bridge/cBTC/call records, and Bitcoin Secret Sats. Update transaction/asset/UTXO/pool pages and indexing health. Source upstream validation as a versioned component or run its indexers alongside Tacitscan with an explicit adapter.

**P2 — Reach full protocol coverage.** Add Ethereum V1/periphery, reflection lifecycle, and the three EVM Secret Sats deployments. Add cross-chain search, asset representations, pool/CDP/farm dashboards, and the Ethereum airdrop read model. This is required for full-protocol explorer parity even though it can ship after Bitcoin fixes.

**Migration/replay requirements:**

1. Preserve raw observations and current links. Replay into versioned/shadow derived tables, then compare results before switching reads.
2. Revisit both unknown and malformed records. Existing `backfill-redecode.ts` only selects `UNKNOWN` with `unknown opcode 0x%`; current `0x2B` burns rejected by the old drop parser are not covered by that filter.
3. Rebuild outputs and state, not just envelope columns. The backfill's mapping does not write commitments. Ordinary upserts only refresh confirmation fields, and commitment inserts use `onConflictDoNothing`, so simply restarting after decoder changes is insufficient.
4. Fetch full transactions/blocks to discover later-input spends: their bytes were never stored. Existing `rawWitness` stores the leaf script, not the full transaction or every witness.
5. Replay accepted state in canonical block/transaction/input order from genesis or a verified complete checkpoint. Tacitscan's configured Bitcoin start is 948241, just before TAC genesis 948242; do not jump to the reflection seed. Start EVM consumers from the appropriate deployment blocks.
6. Make block/state writes and cursor advancement recoverable as one unit. `processBlock` currently catches a failed envelope insert and still advances the block cursor; fix this before a stateful replay so failures cannot create permanent holes.
7. Implement undo/rebuild for new state and reset dependent validation on reorg. Expose migration coverage and lag during rollout.

**Acceptance criteria for implementation:** fixture-based comparison with pinned upstream decoders/validators; current/legacy `0x2B` distinction; BP+ output reconstruction; multi-input Secret Sats and ordering; malformed proofs versus unavailable dependencies; cap ordering; AMM/farm replay and rollback; cross-out/bridge lifecycle; EVM multiple/nested settles with failed inner calls; exact unit conversions; network/deployment isolation; and restart/replay idempotence. Use the real round-trip and Bitcoin AMM founding transactions listed in `docs/DEPLOYMENTS.md` as public regression anchors. These checks are proposed, not executed by this assessment.

## Implementation approach

Keep Astro/Postgres as the explorer presentation and read store. Add versioned adapters around upstream protocol parsing, validation, and event replay, with locally persisted evidence and checkpoint reconciliation. The upstream worker exposes `/amm/pools`, pool operation history, farms, `/confidential/index`, and reflection state; the dedicated Bitcoin pool indexer exposes status, roots, notes, nullifiers, and exits. These are useful integration surfaces, but cached API results must retain their source and freshness and must not silently become independent verification claims.

The critical first milestone is a Bitcoin explorer that correctly displays and accounts for today's accepted operations. Full parity then extends the same evidence model across reflection and the two distinct EVM pool systems.
