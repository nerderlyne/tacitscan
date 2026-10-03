import { reconcileTrees, readAmmReserves } from './evm-state.js';
import { publishReadiness } from './readiness.js';
import { refreshPoolRecords,refreshCanonicalRecords } from './reference-records.js';
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { makeRpc } from './evm.js';
import { keccak256, toHex } from 'viem';
import deployments from './vendor/deployments.json' with { type: 'json' };

export async function readJson(url:URL,timeout=15_000):Promise<Record<string,any>> {
  const r=await fetch(url,{signal:AbortSignal.timeout(timeout),headers:{accept:'application/json'}});
  if(!r.ok) throw new Error(`reference HTTP ${r.status}`);
  const text=await r.text(); if(text.length>8_000_000) throw new Error('reference response too large');
  const body=JSON.parse(text);
  if(!body || typeof body!=='object' || Array.isArray(body) || body.error) throw new Error('invalid reference response');
  return body;
}
export async function readAllPages(base:URL,path:string,key:string,network:string) {
  const collected:unknown[]=[]; const cursors=new Set<string>(); let cursor:string|undefined;
  for(let page=0;page<100;page++) {
    const url=new URL(path,base);url.searchParams.set('network',network);url.searchParams.set('limit','100');
    if(cursor) url.searchParams.set('cursor',cursor);
    const body=await readJson(url);
    if(!Array.isArray(body[key])) throw new Error(`missing ${key} array`);
    collected.push(...body[key]);
    if(!body.cursor) return {[key]:collected,network,complete:true};
    if(typeof body.cursor!=='string' || cursors.has(body.cursor)) throw new Error('reference pagination stalled');
    cursor=body.cursor;cursors.add(cursor);
  }
  throw new Error('reference pagination limit exceeded');
}
async function snapshot(source:string,resource:string,fetcher:()=>Promise<unknown>) {
  try {
    const body=await fetcher();
    await db.execute(sql`INSERT INTO protocol_snapshots(source,resource,body) VALUES(${source},${resource},${JSON.stringify(body)}::jsonb)
      ON CONFLICT(source,resource) DO UPDATE SET body=EXCLUDED.body,fetched_at=now(),error=NULL`);
  } catch(e) {
    const error=e instanceof Error?e.message:'reference unavailable';
    await db.execute(sql`INSERT INTO protocol_snapshots(source,resource,body,error) VALUES(${source},${resource},'{}',${error})
      ON CONFLICT(source,resource) DO UPDATE SET error=EXCLUDED.error`);
  }
}
// Acceptance evidence is explicitly attributed to the reference worker. Its
// scanned height and decision are retained, never promoted to a local proof.
async function refreshSwapEvidence(base:URL,network:string) {
  const rows=await db.execute<{txid:string;input_index:number;block_height:number;block_hash:string}>(sql`
    SELECT txid,input_index,block_height,block_hash FROM protocol_envelopes
    WHERE network=${network} AND chain_status='confirmed' AND decode_status='decoded'
      AND opcode IN ('T_SWAP_VAR','T_SWAP_ROUTE')
    ORDER BY validation_evidence->>'fetchedAt' ASC NULLS FIRST LIMIT 20`);
  for(const row of rows) {
    try {
      const url=new URL('/amm/swap-accepted',base);
      url.searchParams.set('network',network);url.searchParams.set('txid',row.txid);
      const evidence=await readJson(url);
      if(evidence.txid!==row.txid || evidence.network!==network || typeof evidence.accepted!=='boolean') throw new Error('reference identity mismatch');
      const caughtUp=Number.isSafeInteger(evidence.scanned_height)&&evidence.scanned_height>=row.block_height;
      const matchingHeight=evidence.height===row.block_height;
      const status=!caughtUp?'reference-pending':evidence.accepted&&matchingHeight?'reference-accepted':!evidence.accepted?'reference-not-accepted':'reference-height-mismatch';
      const stored={...evidence,source:base.origin,provenance:'reference-indexer',fetchedAt:new Date().toISOString(),localBlockHash:row.block_hash};
      await db.execute(sql`UPDATE protocol_envelopes SET validation_status=${status},validation_evidence=${JSON.stringify(stored)}::jsonb
        WHERE network=${network} AND txid=${row.txid} AND input_index=${row.input_index} AND block_hash=${row.block_hash} AND chain_status='confirmed'`);
    } catch { /* Keep the prior timestamp and evidence when dependencies fail. */ }
  }
}
export async function refreshReferences() {
  const network=process.env.BITCOIN_NETWORK??'mainnet';
  if(process.env.TACIT_REFERENCE_URL) {
    const base=new URL(process.env.TACIT_REFERENCE_URL);
    if(process.env.ACCEPTED_STATE_ENABLED==='true') {
      try {await refreshCanonicalRecords(base,network);} catch(e) {
        await db.execute(sql`UPDATE protocol_snapshots SET error=${e instanceof Error?e.message:'Canonical import unavailable'} WHERE source=${'tacit:'+network} AND resource='accepted-state'`);
      }
    }
    if(process.env.PARITY_INDEXING_ENABLED==='true') await refreshSwapEvidence(base,network);
    for(const [path,key] of [['/amm/pools','pools'],['/farms','farms']]) {
      await snapshot(`tacit:${network}`,key!,async()=>({source:base.origin,provenance:'reference-indexer',...await readAllPages(base,path!,key!,network)}));
    }
    for(const [path,key] of [['/farm/program','farm-program'],['/farm/health','farm-health']]) {
      await snapshot(`tacit:${network}`,key!,async()=>{
        const url=new URL(path!,base);url.searchParams.set('network',network);
        return {...await readJson(url),source:base.origin,provenance:'reference-indexer',coverage:'reference snapshot'};
      });
    }
  }
  if(process.env.BTC_POOL_REFERENCE_URL) {
    const base=new URL(process.env.BTC_POOL_REFERENCE_URL);
    if(process.env.ACCEPTED_STATE_ENABLED==='true') {
      try {await refreshPoolRecords(base,network);} catch(e) {
        await db.execute(sql`UPDATE protocol_snapshots SET error=${e instanceof Error?e.message:'Pool import unavailable'} WHERE source=${'btc-pool:'+network} AND resource='accepted-records'`);
      }
    }
    for(const path of ['status','roots']) await snapshot(`btc-pool:${network}`,path,async()=>{
      const status=await readJson(new URL('/btc-pool/status',base));
      if(status.network!==network) throw new Error('shielded-pool network mismatch');
      const data=path==='status'?status:await readJson(new URL('/btc-pool/roots',base));
      return {...data,source:base.origin,provenance:'reference-indexer'};
    });
  }
  // Public on-chain gauges are taken at one explicit block, independently of
  // any API's claims. They never expose or estimate confidential balances.
  for(const chain of [1,8453,4663]) {
    const url=process.env[`EVM_RPC_URL_${chain}`];if(!url) continue;
    await snapshot(`evm:${chain}`,'state',async()=>{
      const rpc=makeRpc(url);
      if(Number(BigInt(await rpc<string>('eth_chainId')))!==chain) throw new Error('RPC chain ID mismatch');
      const tip=BigInt(await rpc<string>('eth_blockNumber'));const tag='0x'+(tip-12n).toString(16);
      const before=await rpc<{hash:string}>('eth_getBlockByNumber',[tag,false]);
      const values:Record<string,Record<string,string>>={};
      const trees:unknown[]=[];let pools:Record<string,unknown>={};
      for(const c of deployments.contracts.filter(c=>c.chainId===chain)) {
        if(c.startBlock>Number(BigInt(tag))) continue;
        if(c.name==='ConfidentialPool'||c.name==='TacitEvmPool') trees.push(...await reconcileTrees(rpc,chain,c.address,c.name,Number(BigInt(tag))));
        if(c.name==='ConfidentialPool') pools=await readAmmReserves(rpc,chain,c.address,Number(BigInt(tag)));
        const calls=c.name==='ConfidentialPool'?['nextLeafIndex()','currentRoot()','cbtcBackingSats()','successor()','attestedReflectionDigest()','attestedReflectionTip()','attestedBitcoinConsumedCount()','attestedCrossOutCount()']:
          c.name==='CollateralEngine'?['outstandingCusd()','normalizedDebtRay()','rate()','stabilityFeePerSecond()','lastDrip()','feeBudgetCusd()','feesAccruedCusd()','surplusFeeCusd()','savingsRps()','totalSavingsShares()','totalSavingsRewardDebt()','escrowRatioBps()','cdpRatioBps()','liqRatioBps()']:c.name==='TacitEvmPool'?['root()']:
          c.name==='ERC20'||c.name==='WrappedTac'?['totalSupply()']:[];
        if(!calls.length) continue;
        const state:Record<string,string>={};
        for(const sig of calls) {
          const result=await rpc<string>('eth_call',[{to:c.address,data:keccak256(toHex(sig)).slice(0,10)},tag]);
          if(!/^0x[0-9a-f]{64}$/i.test(result)) throw new Error(`invalid ${sig} result`);
          state[sig]=sig.includes('Root')||sig==='root()'||sig==='successor()'||sig==='attestedReflectionDigest()'||sig==='attestedReflectionTip()'?result:BigInt(result).toString();
        }
        values[c.address]=state;
      }
      const tokens=await db.execute<{address:string;height:string}>(sql`SELECT lower(decoded->>'token') AS address,min(block_height)::text AS height FROM protocol_events WHERE chain_id=${chain} AND event_name='Deployed' AND block_height<=${Number(BigInt(tag))} GROUP BY lower(decoded->>'token')`);
      for(const {address} of tokens) {
        if(!/^0x[0-9a-f]{40}$/.test(address)||values[address]) continue;
        const raw=await rpc<string>('eth_call',[{to:address,data:keccak256(toHex('totalSupply()')).slice(0,10)},tag]);
        values[address]={'totalSupply()':BigInt(raw).toString()};
      }
      const supply=[];
      for(const [address,state] of Object.entries(values)) {
        if(state['totalSupply()']===undefined) continue;
        const start=deployments.contracts.find(c=>c.chainId===chain&&c.address===address)?.startBlock??Number(tokens.find(t=>t.address===address)!.height);
        const openingRaw=await rpc<string>('eth_call',[{to:address,data:keccak256(toHex('totalSupply()')).slice(0,10)},'0x'+(start-1).toString(16)]);
        const opening=openingRaw==='0x'?0n:BigInt(openingRaw);
        const rows=await db.execute<{net:string}>(sql`SELECT (coalesce(sum((decoded->>'value')::numeric) FILTER(WHERE decoded->>'from'='0x0000000000000000000000000000000000000000'),0)-coalesce(sum((decoded->>'value')::numeric) FILTER(WHERE decoded->>'to'='0x0000000000000000000000000000000000000000'),0))::text AS net FROM protocol_events WHERE chain_id=${chain} AND address=${address} AND event_name='Transfer' AND block_height BETWEEN ${start} AND ${Number(BigInt(tag))}`);
        const net=BigInt(rows[0]!.net),total=BigInt(state['totalSupply()']);
        supply.push({address,fromHeight:start,openingSupply:opening.toString(),eventNetIssued:net.toString(),totalSupply:total.toString(),matches:opening+net===total});
      }
      if((await rpc<{hash:string}>('eth_getBlockByNumber',[tag,false])).hash!==before.hash) throw new Error('chain changed during state read');
      if(chain===1) {
        const pool=deployments.contracts.find(c=>c.chainId===1&&c.name==='ConfidentialPool')!;
        const state=values[pool.address];
        if(state) {
          const hash=state['attestedReflectionTip()'];
          const displayHash=hash?Buffer.from(hash.slice(2),'hex').reverse().toString('hex'):'';
          const anchor=await db.execute<{height:number}>(sql`SELECT height FROM blocks WHERE network=${network} AND block_hash=${displayHash}`);
          await snapshot('evm:1','reflection',async()=>({pool:pool.address,network,ethereumHeight:Number(BigInt(tag)),ethereumBlockHash:before.hash,attestedHeight:anchor[0]?.height??null,bitcoinBlockHash:displayHash,digest:state['attestedReflectionDigest()'],bitcoinConsumedCount:state['attestedBitcoinConsumedCount()'],crossOutCount:state['attestedCrossOutCount()'],confirmations:24,provenance:'rpc-contract-state'}));
        }
      }
      return {chainId:chain,height:Number(BigInt(tag)),blockHash:before.hash,provenance:'rpc-contract-state',contracts:values,trees,pools,supply};
    });
  }
}
export async function runReferences():Promise<never> {
  for(;;) {
    try {await refreshReferences();await publishReadiness();} catch(e) {
      console.error('[reference] refresh failed',e instanceof Error?e.message:'unknown error');
      await db.execute(sql`UPDATE protocol_snapshots SET error=${e instanceof Error?e.message:'Readiness unavailable'} WHERE source='tacitscan' AND resource='readiness'`).catch(()=>{});
    }
    await new Promise(r=>setTimeout(r,60_000));
  }
}
