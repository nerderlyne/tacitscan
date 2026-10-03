import { runAcceptedState } from './accepted-state.js';
import { runEvmIndexer } from './evm.js';
import { runReferences } from './reference.js';
import { runIndexer } from "./indexer.js";
import { runResolver } from "./resolver.js";
import { runValidator } from "./validator.js";
import { runMintValidator } from "./mint-validator.js";
import { runMempoolPoller } from "./mempool.js";
import { backfillSpendingPubkey } from "./backfill-spending-pubkey.js";
import { backfillRedecode } from "./backfill-redecode.js";
import { backfillCommitTxid } from "./backfill-commit-txid.js";

// Five independent loops in the same process:
//   indexer        — block walker, decodes envelopes, writes to DB
//   mempool        — polls /mempool/txids and inserts unconfirmed envelopes
//                    so the explorer can show 0-conf txs (Etherscan-style).
//                    Block walker promotes mempool rows to confirmed via
//                    ON CONFLICT DO UPDATE on the envelopes PK.
//   resolver       — fetches IPFS metadata, follows NFT-style image fields
//   validator      — runs Pedersen + parent + amount + height checks
//                    on T_PMINT rows (SPEC §5.9)
//   mint-validator — runs BIP-340 Schnorr issuer-sig check on T_MINT rows
//                    against parent CETCH's mint_authority (SPEC §5.3)
// One-shot backfills before tip-walk resumes. Idempotent — subsequent
// starts see empty result sets and return fast. Failures shouldn't block
// the indexer; log + continue.
backfillSpendingPubkey().catch((e) => {
  console.error("[backfill-spending-pubkey] failed (continuing):", e);
});
if (process.env.LEGACY_REDECODE_ENABLED === "true") backfillRedecode().catch((e) => {
  console.error("[backfill-redecode] failed (continuing):", e);
});
backfillCommitTxid().catch((e) => {
  console.error("[backfill-commit-txid] failed (continuing):", e);
});

// If the indexer crashes the process exits and Railway restarts us —
// partial progress is checkpointed in DB. The auxiliary loops are caught
// so a flaky external dep can't take down the indexer.
const extensions: Promise<unknown>[] = [];
if(process.env.ACCEPTED_STATE_ENABLED==='true') {
  if(process.env.PARITY_INDEXING_ENABLED!=='true'||process.env.REFERENCE_INDEXING_ENABLED!=='true'||!process.env.BTC_POOL_REFERENCE_URL||!process.env.TACIT_REFERENCE_URL) throw new Error('Accepted-state indexing requires protocol indexing and both private reference services');
  extensions.push(runAcceptedState());
}
if (process.env.REFERENCE_INDEXING_ENABLED === 'true') extensions.push(runReferences());
if (process.env.EVM_INDEXING_ENABLED === 'true') for (const chain of [1,8453,4663]) {
  const url=process.env[`EVM_RPC_URL_${chain}`];
  if(url) extensions.push(runEvmIndexer(chain,url));
}
Promise.all([
  ...extensions,
  runIndexer(),
  runMempoolPoller().catch((e) => {
    console.error("[mempool] crashed (continuing without it):", e);
  }),
  runResolver().catch((e) => {
    console.error("[resolver] crashed (continuing without it):", e);
  }),
  runValidator().catch((e) => {
    console.error("[validator] crashed (continuing without it):", e);
  }),
  runMintValidator().catch((e) => {
    console.error("[mint-validator] crashed (continuing without it):", e);
  }),
]).catch((err) => {
  console.error("indexer crashed:", err);
  process.exit(1);
});
