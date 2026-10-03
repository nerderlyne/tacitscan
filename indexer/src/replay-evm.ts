// Explicit repair of the derived EVM tail; stop the corresponding worker first.
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { makeRpc,runEvmIndexer } from './evm.js';
import deployments from './vendor/deployments.json' with {type:'json'};
async function main() {
  const args=process.argv.slice(2),read=(name:string)=>args[args.indexOf(name)+1];
  const chain=Number(read('--chain'));let from=Number(read('--from'));
  if(![1,8453,4663].includes(chain)||!Number.isSafeInteger(from)||from<Math.min(...deployments.contracts.filter(c=>c.chainId===chain).map(c=>c.startBlock))) throw new Error('Usage: pnpm replay:evm --chain ID --from HEIGHT [--apply]');
  const source=`evm:${chain}`;
  const window=(await db.execute<{first_height:string}>(sql`SELECT first_height FROM protocol_scan_windows WHERE source=${source} AND first_height<=${from} AND last_height>=${from} ORDER BY first_height LIMIT 1`))[0];
  if(window) from=Number(window.first_height);
  const cursor=(await db.execute<{height:string;block_hash:string}>(sql`SELECT height,block_hash FROM protocol_cursors WHERE source=${source}`))[0];
  if(!cursor||from>Number(cursor.height)) throw new Error('No existing tail to repair');
  console.log(`Plan: replace derived ${source} records ${from}..${cursor.height}; replay to the saved cursor. Stop the EVM worker first.`);
  if(!args.includes('--apply')) return;
  if(chain===1&&process.env.EVM_REQUIRE_CALL_TRACES!=='true') throw new Error('Complete Ethereum repair requires EVM_REQUIRE_CALL_TRACES=true');
  const url=process.env[`EVM_RPC_URL_${chain}`];if(!url) throw new Error('Missing RPC');
  const rpc=makeRpc(url);
  if(Number(BigInt(await rpc<string>('eth_chainId')))!==chain) throw new Error('Wrong RPC chain');
  const anchor=await rpc<{hash:string}>('eth_getBlockByNumber',['0x'+(from-1).toString(16),false]);
  await db.transaction(async t=>{
    await t.execute(sql`SELECT pg_advisory_xact_lock(${chain},81421)`);
    const now=(await t.execute<{height:string;block_hash:string}>(sql`SELECT height,block_hash FROM protocol_cursors WHERE source=${source} FOR UPDATE`))[0];
    if(now?.height!==cursor.height||now?.block_hash!==cursor.block_hash) throw new Error('Worker is still running or checkpoint changed');
    await t.execute(sql`DELETE FROM protocol_events WHERE chain_id=${chain} AND block_height>=${from}`);
    await t.execute(sql`DELETE FROM protocol_settlements WHERE chain_id=${chain} AND block_height>=${from}`);
    await t.execute(sql`DELETE FROM protocol_assets WHERE chain_id=${chain} AND block_height>=${from}`);
    await t.execute(sql`DELETE FROM protocol_scan_windows WHERE source=${source} AND last_height>=${from}`);
    await t.execute(sql`DELETE FROM protocol_blocks WHERE source=${source} AND height>=${from}`);
    await t.execute(sql`INSERT INTO protocol_blocks(source,height,block_hash) VALUES(${source},${from-1},${anchor.hash}) ON CONFLICT(source,height) DO UPDATE SET block_hash=EXCLUDED.block_hash`);
    await t.execute(sql`UPDATE protocol_cursors SET height=${from-1},block_hash=${anchor.hash},error=NULL,updated_at=now() WHERE source=${source}`);
    await t.execute(sql`UPDATE protocol_snapshots SET error='EVM replay in progress' WHERE source=${source} OR (source='tacitscan' AND resource='readiness')`);
  });
  await runEvmIndexer(chain,url,Number(cursor.height));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
