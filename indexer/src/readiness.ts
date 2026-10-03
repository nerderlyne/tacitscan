import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { PROTOCOL_REVISION, DECODER_VERSION } from './protocol.js';
import { buildSource, loadConfig } from './indexer.js';
import { makeRpc } from './evm.js';
import deployments from './vendor/deployments.json' with {type:'json'};
export async function evaluateReadiness() {
  const cfg=loadConfig(),checks:{name:string;ready:boolean;detail:string}[]=[];
  const check=(name:string,ready:boolean,detail:string)=>checks.push({name,ready,detail});
  for(const flag of ['PARITY_INDEXING_ENABLED','EVM_INDEXING_ENABLED','REFERENCE_INDEXING_ENABLED','ACCEPTED_STATE_ENABLED','EVM_REQUIRE_CALL_TRACES']) check(flag,process.env[flag]==='true','Required for complete state indexing');
  check('Bitcoin historical start',cfg.network!=='mainnet'||cfg.startHeight<=948241,'Mainnet replay must include the earliest supported deployment');
  const targets:Record<string,number>={};
  try {targets[`bitcoin:${cfg.network}`]=await buildSource(cfg).getTipHeight()-Math.max(3,cfg.confirmationDepth);}
  catch {check('Bitcoin tip',false,'Canonical tip unavailable');}
  for(const chain of [1,8453,4663]) {
    try {
      const rpc=makeRpc(process.env[`EVM_RPC_URL_${chain}`]??'');
      if(Number(BigInt(await rpc<string>('eth_chainId')))!==chain) throw new Error('chain mismatch');
      targets[`evm:${chain}`]=Number(BigInt(await rpc<string>('eth_blockNumber')))-12;
    } catch {check(`EVM ${chain} tip`,false,'Configured canonical RPC unavailable');}
  }
  for(const [source,target] of Object.entries(targets)) {
    const bitcoin=source.startsWith('bitcoin:');
    const start=bitcoin?cfg.startHeight:Math.min(...deployments.contracts.filter(c=>`evm:${c.chainId}`===source).map(c=>c.startBlock));
    // Merge overlapping replay windows using the greatest prior endpoint.
    const rows=await db.execute<{covered:string|null}>(sql`
      WITH windows AS (
        SELECT greatest(first_height,${start}) AS lo,least(last_height,${target}) AS hi
        FROM protocol_scan_windows WHERE source=${source} AND revision=${PROTOCOL_REVISION} AND decoder_version=${DECODER_VERSION}
          AND (${bitcoin} OR traced) AND last_height>=${start} AND first_height<=${target}
      ), boundaries AS (
        SELECT lo,hi,max(hi) OVER(ORDER BY lo,hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous FROM windows
      ) SELECT CASE WHEN count(*)=0 OR min(lo)>${start} OR bool_or(lo>coalesce(previous,${start}-1)+1) THEN NULL ELSE max(hi)::text END AS covered FROM boundaries`);
    const cursor=await db.execute<{height:string;block_hash:string;error:string|null}>(sql`SELECT height,block_hash,error FROM protocol_cursors WHERE source=${source}`);
    let canonicalCursor=false;
    if(cursor[0]) try {
      const hash=bitcoin?await buildSource(cfg).getBlockHashByHeight(Number(cursor[0].height)):(await makeRpc(process.env[`EVM_RPC_URL_${source.split(':')[1]}`]!)<{hash:string}>('eth_getBlockByNumber',['0x'+Number(cursor[0].height).toString(16),false])).hash;
      canonicalCursor=hash===cursor[0].block_hash;
    } catch {canonicalCursor=false;}
    check(`${source} replay`,canonicalCursor&&Number(cursor[0]?.height??-1)>=target&&target>=start&&Number(rows[0]?.covered??-1)>=target&&!cursor[0]?.error,`${start}..${target}; continuous reviewed coverage through ${rows[0]?.covered??'missing/gapped'}; cursor ${canonicalCursor?'canonical':'unmatched'}${cursor[0]?.error?'; '+cursor[0].error:''}`);
  }
  for(const [source,resource] of [[`tacit:${cfg.network}`,'accepted-state'],[`btc-pool:${cfg.network}`,'accepted-records'],...([1,8453,4663].map(c=>[`evm:${c}`,'state']))]) {
    const rows=await db.execute<{body:Record<string,any>;error:string|null;fresh:boolean}>(sql`SELECT body,error,fetched_at>now()-interval '3 minutes' AS fresh FROM protocol_snapshots WHERE source=${source!} AND resource=${resource!}`);
    const s=rows[0],evm=source!.startsWith('evm:');
    const target=targets[evm?source!:`bitcoin:${cfg.network}`];
    let canonical=false;
    if(s&&!evm) {
      const b=await db.execute(sql`SELECT 1 FROM blocks WHERE network=${cfg.network} AND height=${s.body.height??-1} AND block_hash=${s.body.hash??s.body.blockHash??''}`);canonical=b.length===1;
    } else if(s&&evm) {
      try {const rpc=makeRpc(process.env[`EVM_RPC_URL_${source!.split(':')[1]}`]!);const b=await rpc<{hash:string}>('eth_getBlockByNumber',['0x'+Number(s.body.height).toString(16),false]);canonical=b.hash===s.body.blockHash;} catch {canonical=false;}
    }
    if(s&&!evm) check(`${source} replay start`,Number(s.body.start??s.body.startHeight)<=cfg.startHeight,`Replay starts at ${s.body.start??s.body.startHeight??'unknown'}`);
    const current=!!s&&s.fresh&&!s.error&&canonical&&target!==undefined&&s.body.height>=target&&(evm||s.body.sourceRevision===PROTOCOL_REVISION);
    check(`${source} ${resource}`,current,s?.error??(!s?'No published state':`Checkpoint ${s.body.height}, target ${target??'unknown'}, ${s.fresh?'recent':'stale'}, ${canonical?'canonical':'unmatched anchor'}`));
    if(evm&&s) for(const [address,state] of Object.entries(s.body.contracts??{}) as [string,Record<string,any>][]) {
      const successor=state['successor()'];
      if(successor&&BigInt(successor)!==0n) check(`${address} generation`,false,`Successor ${successor}: review and index the new deployment before upgrading`);
    }
    if(evm&&s) check(`${source} supply`,s.body.supply?.every((t:any)=>t.matches)===true,'Opening supply plus canonical mint/burn events must match totalSupply');
    if(evm&&s) check(`${source} trees`,s.body.trees?.every((t:any)=>t.matches)===true,'Public event leaves must reconcile to on-chain roots/counts');
  }
  for(const resource of ['reflection','farm-program','farm-health']) {
    const rows=await db.execute<{fresh:boolean;error:string|null}>(sql`SELECT (fetched_at>now()-interval '3 minutes' AND coalesce(body->>'stale','false')<>'true') AS fresh,error FROM protocol_snapshots WHERE source=${resource==='reflection'?'evm:1':'tacit:'+cfg.network} AND resource=${resource}`);
    check(resource,!!rows[0]?.fresh&&!rows[0]?.error,rows[0]?.error??(rows[0]?.fresh?'Recent reference state':'Reference state unavailable or stale'));
  }
  const counts=await db.execute<{pending:string;unavailable:string;unsupported:string;evm_unknown:string;settlements:string}>(sql`SELECT
    (SELECT count(*)::text FROM protocol_validation_jobs WHERE network=${cfg.network} AND status='pending') AS pending,
    (SELECT count(*)::text FROM protocol_validation_jobs WHERE network=${cfg.network} AND last_error IS NOT NULL) AS unavailable,
    (SELECT count(*)::text FROM protocol_envelopes WHERE network=${cfg.network} AND chain_status='confirmed' AND (support='unverified-extension' OR opcode='UNKNOWN')) AS unsupported,
    (SELECT count(*)::text FROM protocol_events WHERE event_name='Unknown') AS evm_unknown,
    (SELECT count(*)::text FROM protocol_settlements WHERE decode_error IS NOT NULL OR authority='unconfirmed-calldata') AS settlements`);
  for(const [name,count] of Object.entries(counts[0]??{})) check(name,count==='0',`${count} unresolved records`);
  return {ready:checks.every(c=>c.ready),sourceRevision:PROTOCOL_REVISION,decoderVersion:DECODER_VERSION,checkedAt:new Date().toISOString(),targets,checks};
}
export async function publishReadiness() {
  const body=await evaluateReadiness();
  await db.execute(sql`INSERT INTO protocol_snapshots(source,resource,body) VALUES('tacitscan','readiness',${JSON.stringify(body)}::jsonb) ON CONFLICT(source,resource) DO UPDATE SET body=EXCLUDED.body,fetched_at=now(),error=NULL`);
  return body;
}
