// Runs Tacit's canonical shielded replay and transparent-output validator.
// No wallet, relayer or signing endpoint is started.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root=process.env.TACIT_SOURCE_DIR||'/opt/tacit';
const upstream=f=>import(pathToFileURL(`${root}/${f}`).href);
const revision='7a917a8ec4dad72210351d80bcbf269073ac790d';
if(readFileSync(`${root}/.git/HEAD`,'utf8').trim()!==revision) throw new Error('Unexpected Tacit source revision');
for(const key of ['RELAY_KEY','NETWORK_PRIVATE_KEY','BTC_POOL_RELAYER_BTC_KEY','BTC_POOL_RELAYER_POOL_SEED']) if(process.env[key]) throw new Error(`Forbidden signing secret ${key}`);
const network=process.env.BITCOIN_NETWORK||'mainnet';
const stateUrl=process.env.TACIT_REFERENCE_URL || (process.env.TACIT_REFERENCE_HOSTPORT ? `http://${process.env.TACIT_REFERENCE_HOSTPORT}` : undefined);
if(!stateUrl) throw new Error('TACIT_REFERENCE_URL is required');
process.env.TACIT_WORKER_BASE=stateUrl;
// Keep canonical validation on the selected replay, including the dapp fallback.
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=new URL(String(input?.url??input));
  if(['api.tacit.finance','tacit-pin.rosscampbell9.workers.dev'].includes(url.hostname)) {
    const local=new URL(url.pathname+url.search,stateUrl);
    return originalFetch(local,init);
  }
  return originalFetch(input,init);
};
const [{createIndexer,createHandler},{makeEsplora,CHAIN_PARAMS,parseTx},{openBtcPoolStore},{makeBtcPoolVerifier},{makeShieldInputResolver}]=await Promise.all([
  upstream('worker-relay/src/btc-pool-indexer.js'),upstream('worker-relay/src/lib/btc-pool-chain.js'),
  upstream('worker-relay/src/lib/btc-pool-store.js'),upstream('worker-relay/src/lib/btc-pool-verify.js'),upstream('worker-relay/src/lib/btc-pool-transparent.js'),
]);
const startHeight=Number(process.env.BTC_POOL_START_HEIGHT||948241);
const checkpoint=process.env.BTC_POOL_CHECKPOINT?.match(/^(\d+):([0-9a-f]{64})$/);
if(network==='mainnet'&&!checkpoint) throw new Error('Set a reviewed BTC_POOL_CHECKPOINT (height:hash)');
if(checkpoint&&(!Number.isSafeInteger(Number(checkpoint[1]))||Number(checkpoint[1])>startHeight)) throw new Error('Checkpoint must be at or before the replay start');
const chain={...CHAIN_PARAMS[network],...(checkpoint?{checkpoint:{height:Number(checkpoint[1]),hash:checkpoint[2]}}:{})};
const esplora=makeEsplora(process.env.BTC_POOL_ESPLORA||(network==='signet'?'https://mempool.space/signet/api':'https://mempool.space/api,https://blockstream.info/api'),{hashQuorum:Number(process.env.BTC_POOL_HASH_QUORUM||1)});
const store=openBtcPoolStore(process.env.BTC_POOL_DB||'/data/pool.db');
const verifier=makeBtcPoolVerifier({network});
if(!verifier.enabled) throw new Error(verifier.reason);
await verifier.ready();
const ix=createIndexer({store,esplora,verifier,network,startHeight,confirmations:Number(process.env.CONFIRMATION_DEPTH||3)+1,chain});
const resolve=makeShieldInputResolver({esplora,network,exits:()=>ix.state.exits});
const handler=createHandler(ix,store);
let pending=Promise.resolve(),queued=0;
const serial=fn=>{
  if(queued>=4) return Promise.reject(new Error('Validation queue busy'));
  queued++;const run=pending.then(fn).finally(()=>{queued--;});pending=run.catch(()=>{});return run;
};
const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
createServer(async(req,res)=>{
  try {
    if(req.method!=='GET') return send(res,405,{error:'read-only'});
    const url=new URL(req.url,'http://pool');
    if(url.pathname==='/tacitscan/status') return send(res,200,{...ix.status(),sourceRevision:revision,aggregateAvailable:!!verifier.verifyAggregate,aggregateReason:verifier.aggReason});
    const match=url.pathname.match(/^\/tacitscan\/output\/([0-9a-f]{64})\/(\d+)$/);
    if(match) return await serial(async()=>{
      const txid=match[1],vout=Number(match[2]);
      if(!Number.isSafeInteger(vout)||vout>0xffffffff) return send(res,400,{error:'invalid output'});
      const status=await esplora.txStatus(txid);
      if(!status.confirmed) return send(res,200,{txid,vout,network,decision:'pending',reason:'transaction not confirmed',sourceRevision:revision});
      // State-dependent notes must never be rejected while the state service is behind.
      const response=await originalFetch(new URL('/tacitscan/status',stateUrl),{signal:AbortSignal.timeout(15000)});
      if(!response.ok) throw new Error('Canonical state unavailable');
      const state=await response.json();
      if(state.network!==network||state.sourceRevision!==revision||state.height<status.block_height||state.error) throw new Error('Canonical state is not caught up');
      if(ix.state.tip===null||ix.state.tip<status.block_height||ix.halted) throw new Error('Pool replay is not caught up');
      const note=await resolve(txid,vout,{height:status.block_height});
      const raw=note?parseTx(await esplora.rawTx(txid)).tx:null;
      if(raw&&raw.txid!==txid) throw new Error('Raw transaction identity mismatch');
      const script=raw?.vout[vout]?.scriptPubKey;
      const authKey=script?.length===34&&script[0]===0x51&&script[1]===0x20?Buffer.from(script.slice(2)).toString('hex'):null;
      const endStatus=await esplora.txStatus(txid);
      const endResponse=await originalFetch(new URL('/tacitscan/status',stateUrl),{signal:AbortSignal.timeout(15000)});
      const endState=await endResponse.json();
      if(!endStatus.confirmed||endStatus.block_hash!==status.block_hash||!endResponse.ok||endState.epoch!==state.epoch||endState.error) throw new Error('Canonical state changed during validation');
      return send(res,200,{txid,vout,network,decision:note?'accepted':'rejected',height:status.block_height,blockHash:status.block_hash,sourceRevision:revision,epoch:state.epoch,view:'current-canonical',checkedAt:new Date().toISOString(),note:note?{asset:note.asset,authKey,cx:Buffer.from(note.Cx).toString('hex'),cy:Buffer.from(note.Cy).toString('hex'),bound:!!note.bound}:null});
    });
    if(url.pathname==='/tacitscan/records') {
      const kind=url.searchParams.get('kind');
      const tables={notes:'leaves',nullifiers:'nullifiers',exits:'exits',envelopes:'envelopes'};
      if(!Object.hasOwn(tables,kind)) return send(res,400,{error:'invalid record kind'});
      const at=Number(url.searchParams.get('at')),after=Number(url.searchParams.get('after')??'-1');
      if(!Number.isSafeInteger(at)||!Number.isSafeInteger(after)||after< -1||at>(ix.state.tip??-1)) return send(res,409,{error:'snapshot not available'});
      const anchor=store.block(at);
      if(!anchor) return send(res,409,{error:'snapshot not replayed'});
      const rawRows=store.db.prepare(`SELECT r.rowid AS rid,r.*,b.hash AS block_hash FROM ${tables[kind]} r JOIN blocks b ON b.height=r.height WHERE r.height<=? AND r.rowid>? ORDER BY r.rowid LIMIT 1000`).all(at,after);
      const rows=rawRows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Buffer.isBuffer(v)?'0x'+v.toString('hex'):v])));
      return send(res,200,{network,sourceRevision:revision,height:at,blockHash:anchor.hash,root:anchor.root,kind,rows,next:rows.length?rows.at(-1).rid:after,complete:rows.length<1000});
    }
    if(url.pathname==='/tacitscan/envelopes') {
      const from=Math.max(startHeight,Number(url.searchParams.get('from'))||startHeight);
      const to=Math.min(ix.state.tip??startHeight-1,from+99);
      const rows=store.db.prepare('SELECT e.*,b.hash AS block_hash FROM envelopes e JOIN blocks b USING(height) WHERE e.height>=? AND e.height<=? ORDER BY height,tx_index,vin').all(from,to);
      return send(res,200,{network,sourceRevision:revision,from,to,next:to+1,height:ix.state.tip,rows});
    }
    handler(req,res);
  } catch(e) {send(res,503,{error:'dependency unavailable',reason:String(e.message).slice(0,200)});}
}).listen(Number(process.env.PORT||8788),process.env.BIND_HOST||'127.0.0.1');
for(;;) {
  try {await serial(()=>ix.syncOnce({maxBlocks:1}));ix.lastError=null;}
  catch(e) {ix.lastError=e.message;console.error('[pool]',e.message);}
  await new Promise(r=>setTimeout(r,ix.lastError?15000:1000));
}
