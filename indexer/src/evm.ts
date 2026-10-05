import './rpc-config.js';
import { readSettlements,readBlockCallTraces } from './settlements.js';
import { decodeEventLog, type Abi, type Hex } from 'viem';
import { sql } from 'drizzle-orm';
import deployments from './vendor/deployments.json' with { type: 'json' };
import eventAbis from './vendor/evm-events.json' with { type: 'json' };
import { jsonSafe, PROTOCOL_REVISION, DECODER_VERSION } from './protocol.js';
import { db } from './db.js';

export interface EvmLog {address:string; topics:Hex[]; data:Hex; transactionHash:Hex; logIndex:Hex; blockNumber:Hex; blockHash:Hex; removed?:boolean;}
export function decodeEvmLog(log:EvmLog, name:string) {
  const abi=eventAbis[name as keyof typeof eventAbis] as Abi | undefined;
  if(!abi) return {eventName:'Unknown',args:{topics:log.topics,data:log.data}};
  try {
    const value=decodeEventLog({abi,topics:log.topics as [Hex,...Hex[]],data:log.data,strict:true});
    // Viem returns undefined for argument-free events (e.g. ContractURIUpdated).
    // Always supply JSON to the insert; undefined leaves an empty SQL fragment.
    return {eventName:value.eventName!,args:jsonSafe(value.args ?? {})};
  }
  catch {return {eventName:'Unknown',args:{topics:log.topics,data:log.data}};}
}
export function makeRpc(url:string) {
  return async <T>(method:string,params:unknown[]=[]):Promise<T>=>{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20_000)});
    if(!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body=await response.json() as {result?:T;error?:unknown};
    if(body.error || body.result===undefined || body.result===null) throw new Error(`${method}: unavailable result`);
    return body.result;
  };
}
const hex=(n:number)=>'0x'+n.toString(16);
const num=(h:string)=>{const n=Number(BigInt(h));if(!Number.isSafeInteger(n)||n<0) throw new Error('unsafe block number');return n;};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

export async function runEvmIndexer(chainId:number,url:string,stopAt?:number):Promise<void> {
  const rpc=makeRpc(url);
  const pinned=deployments.contracts.filter(c=>c.chainId===chainId);
  if(!pinned.length) throw new Error('unsupported chain');
  const start=Math.min(...pinned.map(c=>c.startBlock));
  const source=`evm:${chainId}`;
  const block=(height:number)=>rpc<{hash:string;number:string}>('eth_getBlockByNumber',[hex(height),false]);
  // Each iteration is bounded; all state changes and cursor advancement commit together.
  for(;;) {
    try {
      const contracts=[...pinned];
      const tokens=await db.execute<{address:string;height:string}>(sql`SELECT lower(decoded->>'token') AS address,min(block_height)::text AS height FROM protocol_events WHERE chain_id=${chainId} AND event_name='Deployed' AND address=ANY(ARRAY[${sql.join(pinned.filter(c=>c.name==='CanonicalAssetFactory').map(c=>sql`${c.address}`),sql`, `)}]::text[]) GROUP BY lower(decoded->>'token')`);
      for(const token of tokens) if(/^0x[0-9a-f]{40}$/.test(token.address)&&!contracts.some(c=>c.address===token.address)) contracts.push({chainId,address:token.address,name:'ERC20',family:'asset',startBlock:Number(token.height)});
      if(num(await rpc<string>('eth_chainId'))!==chainId) throw new Error('RPC chain ID mismatch');
      const rows=await db.execute<{height:string;block_hash:string}>(sql`SELECT height,block_hash FROM protocol_cursors WHERE source=${source}`);
      let height=rows[0]?Number(rows[0].height):start-1;
      let previous=rows[0]?.block_hash??'';
      if (!rows[0]) {
        const initial=await block(height);
        await db.transaction(async t=>{
          await t.execute(sql`SELECT pg_advisory_xact_lock(${chainId},81421)`);
          await t.execute(sql`INSERT INTO protocol_blocks(source,height,block_hash) VALUES(${source},${height},${initial.hash}) ON CONFLICT DO NOTHING`);
          await t.execute(sql`INSERT INTO protocol_cursors(source,height,block_hash) VALUES(${source},${height},${initial.hash}) ON CONFLICT DO NOTHING`);
        });
        continue;
      }
      if(previous && (await block(height)).hash!==previous) {
        const checkpoints=await db.execute<{height:string;block_hash:string}>(sql`SELECT height,block_hash FROM protocol_blocks WHERE source=${source} AND height<${height} ORDER BY height DESC LIMIT 64`);
        let ancestor:{height:number;hash:string}|null=null;
        for(const c of checkpoints) if((await block(Number(c.height))).hash===c.block_hash) {ancestor={height:Number(c.height),hash:c.block_hash};break;}
        if(!ancestor) throw new Error('EVM reorg exceeds retained checkpoints; explicit replay required');
        await db.transaction(async t=>{
          await t.execute(sql`SELECT pg_advisory_xact_lock(${chainId},81421)`);
          const current=await t.execute<{height:string;block_hash:string}>(sql`SELECT height,block_hash FROM protocol_cursors WHERE source=${source} FOR UPDATE`);
          if(Number(current[0]?.height)!==height || current[0]?.block_hash!==previous) throw new Error('cursor changed during rewind');
          await t.execute(sql`DELETE FROM protocol_scan_windows WHERE source=${source} AND last_height>${ancestor!.height}`);
          await t.execute(sql`DELETE FROM protocol_events WHERE chain_id=${chainId} AND block_height>${ancestor!.height}`);
          await t.execute(sql`DELETE FROM protocol_settlements WHERE chain_id=${chainId} AND block_height>${ancestor!.height}`);
          await t.execute(sql`DELETE FROM protocol_assets WHERE chain_id=${chainId} AND block_height>${ancestor!.height}`);
          await t.execute(sql`DELETE FROM protocol_blocks WHERE source=${source} AND height>${ancestor!.height}`);
          await t.execute(sql`UPDATE protocol_cursors SET height=${ancestor!.height},block_hash=${ancestor!.hash},updated_at=now() WHERE source=${source}`);
        });
        continue;
      }
      const tip=num(await rpc<string>('eth_blockNumber'));
      const safe=Math.min(tip-12,stopAt??Infinity);
      if(height>=safe) {if(stopAt!==undefined&&height>=stopAt) return;await sleep(15_000);continue;}
      const end=Math.min(height+(chainId===1&&process.env.EVM_REQUIRE_CALL_TRACES==='true'?8:128),safe);
      const anchor=await block(end);
      const logs=await rpc<EvmLog[]>('eth_getLogs',[{fromBlock:hex(height+1),toBlock:hex(end),address:contracts.map(c=>c.address)}]);
      if(!Array.isArray(logs)) throw new Error('invalid log response');
      const discovered:string[]=[];
      for(const log of logs) {
        const c=contracts.find(c=>c.address===log.address.toLowerCase());
        if(c?.name!=='CanonicalAssetFactory') continue;
        const decoded=decodeEvmLog(log,c.name);
        if(decoded.eventName!=='Deployed') continue;
        const address=String((decoded.args as Record<string,string>).token).toLowerCase();
        if(!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Invalid canonical token address');
        if(!contracts.some(c=>c.address===address)) {contracts.push({chainId,address,name:'ERC20',family:'asset',startBlock:num(log.blockNumber)});discovered.push(address);}
      }
      if(discovered.length) logs.push(...await rpc<EvmLog[]>('eth_getLogs',[{fromBlock:hex(height+1),toBlock:hex(end),address:discovered}]));
      const hashes=new Map<number,string>();
      for(const log of logs) {
        const h=num(log.blockNumber);
        if(log.removed || h<=height || h>end || !contracts.some(c=>c.address===log.address.toLowerCase())) throw new Error('noncanonical log response');
        if(!hashes.has(h)) hashes.set(h,(await block(h)).hash);
        if(hashes.get(h)!==log.blockHash) throw new Error('log block hash mismatch');
      }
      const pool=contracts.find(c=>c.name==='ConfidentialPool');
      const amm=contracts.find(c=>c.name==='TacitPublicAmm')?.address;
      const traces=pool&&process.env.EVM_REQUIRE_CALL_TRACES==='true'?await readBlockCallTraces(rpc,height+1,end,pool.address,amm,logs):new Map();
      const settlements=pool?await readSettlements(rpc,pool.address,logs,amm,traces):new Map();
      if((await block(end)).hash!==anchor.hash || (previous && (await block(height)).hash!==previous)) throw new Error('chain changed during log scan');
      logs.sort((a,b)=>num(a.blockNumber)-num(b.blockNumber)||num(a.logIndex)-num(b.logIndex));
      await db.transaction(async t=>{
        // Concurrent duplicate workers cannot commit competing cursor windows.
        await t.execute(sql`SELECT pg_advisory_xact_lock(${chainId}, 81421)`);
        const current=await t.execute<{height:string;block_hash:string}>(sql`SELECT height,block_hash FROM protocol_cursors WHERE source=${source} FOR UPDATE`);
        if(current[0] && (Number(current[0].height)!==height || current[0].block_hash!==previous)) throw new Error('cursor changed in another worker');
        for(const log of logs) {
          const c=contracts.find(c=>c.address===log.address.toLowerCase())!;
          if(num(log.blockNumber)<c.startBlock) continue;
          const decoded=decodeEvmLog(log,c.name);
          await t.execute(sql`INSERT INTO protocol_events(chain_id,address,txid,log_index,block_height,block_hash,family,event_name,decoded,raw_log)
            VALUES(${chainId},${c.address},${log.transactionHash.toLowerCase()},${num(log.logIndex)},${num(log.blockNumber)},${log.blockHash},${c.family},${decoded.eventName},${JSON.stringify(decoded.args)}::jsonb,${JSON.stringify(log)}::jsonb)
            ON CONFLICT(chain_id,txid,log_index) DO UPDATE SET block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash,decoded=EXCLUDED.decoded,event_name=EXCLUDED.event_name,raw_log=EXCLUDED.raw_log`);
          if(decoded.eventName==='AssetRegistered') {
            const a=decoded.args as Record<string,string>;
            await t.execute(sql`INSERT INTO protocol_assets(chain_id,deployment,asset_id,origin,token_address,symbol,name,decimals,unit_scale,block_height,metadata)
              VALUES(${chainId},${c.address},${a.assetId!},'evm-registration',${a.underlying!},${a.symbol!},${a.name!},${Number(a.decimals)},${String(a.unitScale)},${num(log.blockNumber)},${JSON.stringify(a)}::jsonb)
              ON CONFLICT(chain_id,deployment,asset_id) DO UPDATE SET token_address=EXCLUDED.token_address,symbol=EXCLUDED.symbol,name=EXCLUDED.name,decimals=EXCLUDED.decimals,unit_scale=EXCLUDED.unit_scale,block_height=EXCLUDED.block_height,metadata=EXCLUDED.metadata`);
          }
        }
        for(const [txid,calls] of settlements) {
          const log=logs.find(l=>l.transactionHash===txid);
          const blockHeight=log?num(log.blockNumber):traces.get(txid)!.blockHeight;
          const blockHash=log?.blockHash??traces.get(txid)!.blockHash;
          await t.execute(sql`DELETE FROM protocol_settlements WHERE chain_id=${chainId} AND txid=${txid}`);
          for(const call of calls) await t.execute(sql`INSERT INTO protocol_settlements(chain_id,deployment,txid,call_index,block_height,block_hash,authority,public_values,memos,calldata,decode_error)
            VALUES(${chainId},${pool!.address},${txid},${call.callIndex},${blockHeight},${blockHash},${call.authority},${JSON.stringify(call.publicValues)}::jsonb,${JSON.stringify(call.memos)}::jsonb,${call.calldata},${call.error})`);
        }
        await t.execute(sql`INSERT INTO protocol_scan_windows(source,first_height,last_height,block_hash,revision,decoder_version,traced) VALUES(${source},${height+1},${end},${anchor.hash},${PROTOCOL_REVISION},${DECODER_VERSION},${!pool||process.env.EVM_REQUIRE_CALL_TRACES==='true'}) ON CONFLICT(source,first_height,last_height) DO UPDATE SET block_hash=EXCLUDED.block_hash,revision=EXCLUDED.revision,decoder_version=EXCLUDED.decoder_version,traced=EXCLUDED.traced,completed_at=now()`);
        await t.execute(sql`INSERT INTO protocol_blocks(source,height,block_hash) VALUES(${source},${end},${anchor.hash}) ON CONFLICT(source,height) DO UPDATE SET block_hash=EXCLUDED.block_hash`);
        await t.execute(sql`INSERT INTO protocol_cursors(source,height,block_hash) VALUES(${source},${end},${anchor.hash}) ON CONFLICT(source) DO UPDATE SET height=EXCLUDED.height,block_hash=EXCLUDED.block_hash,updated_at=now(),error=NULL`);
      });
    } catch(e) {
      const message=e instanceof Error?e.message:'index failed';
      console.error(`[${source}] ${message}`);
      await db.execute(sql`UPDATE protocol_cursors SET error=${message.slice(0,300)} WHERE source=${source}`).catch(()=>{});
      await sleep(30_000);
    }
  }
}
