// Shared Render environment group uses the explorer RPC names.
if (!process.env.ETHEREUM_RPC_URL && (process.env.EVM_RPC_URL_1 || process.env.RPC_ETH)) {
  process.env.ETHEREUM_RPC_URL = process.env.EVM_RPC_URL_1 || process.env.RPC_ETH;
}
// Keyless, private host for the pinned upstream worker. Only scanner and read
// routes are enabled; state lives in a isolated schema in the explorer Postgres database.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createTransactionalDriver } from './postgres-kv.mjs';
import { makeMirrors } from './esplora-mirrors.mjs';
const root=process.env.TACIT_SOURCE_DIR||'/opt/tacit';
const upstream=(file)=>import(pathToFileURL(`${root}/${file}`).href);
const REVISION='7a917a8ec4dad72210351d80bcbf269073ac790d';
if(readFileSync(`${root}/.git/HEAD`,'utf8').trim()!==REVISION) throw new Error('Unexpected Tacit source revision');
for(const key of ['RELAY_KEY','NETWORK_PRIVATE_KEY','FAUCET_WIF','BTC_POOL_RELAYER_BTC_KEY','BTC_POOL_RELAYER_POOL_SEED']) if(process.env[key]) throw new Error(`Signing secret ${key} is forbidden in the read-only state service`);
const {default:pg}=await upstream('server/node_modules/pg/lib/index.js');
const {createCacheStorage}=await upstream('server/cache-mem.mjs');
const {buildEnv,createCtxFactory}=await upstream('server/harness.mjs');
const driver=await createTransactionalDriver(pg,process.env.DATABASE_URL);
const network=process.env.BITCOIN_NETWORK||'mainnet';
await driver.claimLease(`tacitscan-state:${network}`);
const start=Number(process.env.START_HEIGHT||948241);
if(!['mainnet','signet'].includes(network)||!Number.isSafeInteger(start)||start<1) throw new Error('Invalid replay network/start height');
const metaNamespace='TACITSCAN_STATE_META';
const previous=await driver.get(metaNamespace,network);
let meta=previous?JSON.parse(previous.value.toString()):{epoch:randomBytes(16).toString('hex'),height:start-1,hash:'',start,revision:REVISION};
if(meta.start!==start||meta.revision!==REVISION) throw new Error('Replay parameters changed; use a fresh state database');
let scanError=null;
const save=()=>driver.put(metaNamespace,network,Buffer.from(JSON.stringify(meta)));
await save();
// Epoch isolates every accepted-state rebuild. Old namespaces remain recoverable.
const scoped=new Proxy(driver,{get(target,method){
  if(['get','put','delete','list','count'].includes(method)) return (ns,...args)=>target[method](`${meta.epoch}:${ns}`,...args);
  if(method==='putMany') return rows=>target.putMany(rows.map(r=>({...r,ns:`${meta.epoch}:${r.ns}`})));
  return target[method];
}});
globalThis.caches=createCacheStorage({maxBytes:32*1024*1024});
const worker=(await upstream('worker/src/index.js')).default;
const token=randomBytes(32).toString('hex');
const api=process.env.ESPLORA_URL||(network==='signet'?'https://mempool.space/signet/api':'https://mempool.space/api');
const confirmations=Number(process.env.CONFIRMATION_DEPTH||3);
if(!Number.isSafeInteger(confirmations)||confirmations<3) throw new Error('CONFIRMATION_DEPTH must be at least three');
const originalFetch=globalThis.fetch;
// A failed request names its host and the network error, since a bare "fetch failed" does not say which source to fix.
const hostOf=url=>{try{return new URL(url).host}catch{return '?'}};
const fetchNamed=async(input,init)=>{
  try{return await originalFetch(input,init);}
  catch(e){throw Object.assign(new Error(`${e?.message||e} (${hostOf(String(input?.url??input))}${e?.cause?.code?` ${e.cause.code}`:''})`),{cause:e?.cause??e});}
};
// The Bitcoin source the replay reads, and that the upstream worker it hosts reads through this same fetch. A replay from the
// start height downloads every block since then (tens of gigabytes), enough for one public host to refuse this address for
// hours, so the same API is read from several hosts that serve identical data, paced, rotated, and left alone for a while
// after one refuses (runtime/esplora-mirrors.mjs). ESPLORA_URL leads; ESPLORA_FALLBACK_URL and ESPLORA_MIRROR_URLS add hosts.
const extraMirrors=(process.env.ESPLORA_MIRROR_URLS??(network==='signet'?'':'https://mempool.emzy.de/api,https://mempool.bitaroo.net/api')).split(',');
const bitcoin=makeMirrors({urls:[api,process.env.ESPLORA_FALLBACK_URL||(network==='signet'?'':'https://blockstream.info/api'),...extraMirrors],fetchImpl:originalFetch,gapMs:Number(process.env.ESPLORA_MIN_GAP_MS||120)});
let knownTip=0;
globalThis.fetch=async(input,init)=>{
  const url=String(input?.url??input),get=typeof input==='string'||input instanceof URL?!init?.method||init.method==='GET':input.method==='GET';
  const response=get&&bitcoin.bases.some(m=>url.startsWith(m))?await bitcoin.fetchBitcoin(url,init):await fetchNamed(input,init);
  if(new URL(url).pathname.endsWith('/blocks/tip/height')&&response.ok) {
    const tip=Number(await response.text());
    if(!Number.isSafeInteger(tip)) throw new Error('Invalid Bitcoin tip');
    knownTip=tip;
    return new Response(String(tip-confirmations),{status:200});
  }
  return response;
};
const env=buildEnv(scoped,{extra:{MAINNET_API:api,SIGNET_API:api,DEBUG_TOKEN:token,CRON_NETWORKS:network,SCAN_BLOCKS_MAINNET:'1',SCAN_BLOCKS_SIGNET:'1',ALLOWED_ORIGINS:'*'}});
const ctxFactory=createCtxFactory();
const ethereumRpc=process.env.ETHEREUM_RPC_URL;
if(!ethereumRpc) throw new Error('ETHEREUM_RPC_URL is required for canonical cross-out replay');
// The configured Ethereum RPC first, then public ones, for the same read-only calls: every answer is checked against block hashes.
const ethereumRpcs=[ethereumRpc,...String(process.env.ETHEREUM_RPC_FALLBACK_URLS??'https://ethereum-rpc.publicnode.com').split(',').map(s=>s.trim()).filter(Boolean)].filter((v,i,a)=>a.indexOf(v)===i);
const ethRpc=async(method,params=[])=>{
  let last=null;
  for(const url of ethereumRpcs) {
    try {
      const response=await fetchNamed(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
      const body=await response.json();
      if(response.ok&&!body.error&&body.result!=null) return body.result;
      last=new Error(`Ethereum replay RPC unavailable (${hostOf(url)}: ${response.ok?(body.error?.message||'no result'):`HTTP ${response.status}`})`);
    } catch(e) {last=e;}
  }
  throw last;
};
const {buildCrossoutConsumer}=await upstream('worker/src/crossout-consumer.js');
const {keccak_256}=await upstream('worker/node_modules/@noble/hashes/sha3.js');
const crossouts=buildCrossoutConsumer(env,{network,keccak256:keccak_256,rpcsForNetwork:()=>ethereumRpcs});
if(!crossouts) throw new Error('No pinned cross-out deployment for this network');
const ethBlock=height=>ethRpc('eth_getBlockByNumber',['0x'+height.toString(16),false]);
const cursorKey=network==='signet'?'meta:last_scanned':`meta:last_scanned:${network}`;
await env.REGISTRY_KV.put(cursorKey,String(meta.height));
const getText=async path=>{const r=await fetch(api+path,{signal:AbortSignal.timeout(20000)});if(!r.ok) throw new Error(`Bitcoin source HTTP ${r.status}`);return (await r.text()).trim();};
async function request(path,method='GET',body) {
  const ctx=ctxFactory.makeCtx();
  const response=await worker.fetch(new Request(`http://state${path}`,{method,headers:method==='POST'?{authorization:`Bearer ${token}`,'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})}),env,ctx);
  await ctx._drain();return response;
}
const status=()=>({...meta,network,sourceRevision:REVISION,error:scanError,provenance:'self-hosted-upstream',readOnly:true,bitcoinTip:knownTip||null,bitcoinSources:bitcoin.status()});
const allowed=/^\/(?:assets(?:\/[0-9a-f]{64}(?:\/pmints|\/recent-xfer-txids)?)?|petch-assets(?:\/[0-9a-f]{64})?|amm\/(?:pools|swap-accepted|pool\/[0-9a-f]{64}(?:\/ops|\/head)?)|farms|farm\/(?:program|health|[0-9a-f]{64}(?:\/bonds)?)|reflection\/status|confidential\/index|crossout\/minted)$/;
createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://state');
    if(req.method!=='GET') {res.writeHead(405);res.end();return;}
    if(url.pathname==='/health'||url.pathname==='/tacitscan/status') {res.setHeader('content-type','application/json');res.end(JSON.stringify(status()));return;}
    if(url.pathname==='/tacitscan/changes') {
      const after=url.searchParams.get('after')||'0',at=url.searchParams.get('at')||meta.lastSeq||'0';
      if(!/^\d+$/.test(after)||!/^\d+$/.test(at)||BigInt(at)>BigInt(meta.lastSeq||'0')||url.searchParams.get('epoch')!==meta.epoch) {res.writeHead(409);res.end(JSON.stringify({error:'snapshot changed'}));return;}
      const rows=await driver.changes(meta.epoch,after,at);
      res.setHeader('content-type','application/json');res.end(JSON.stringify({...status(),rows,next:rows.at(-1)?.seq||after,complete:rows.length<1000}));return;
    }
    if(!allowed.test(url.pathname)) {res.writeHead(404);res.end();return;}
    url.searchParams.set('network',network);
    const response=await driver.readOnly(()=>request(url.pathname+url.search));
    res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store','x-tacit-revision':REVISION,'x-tacit-epoch':meta.epoch});
    res.end(await response.text());
  } catch {res.writeHead(503);res.end(JSON.stringify({error:'state unavailable'}));}
}).listen(Number(process.env.PORT||8787),process.env.BIND_HOST||'127.0.0.1');
// The replay is thrown away only for a reorganization every source agrees on: one host answering with a stale or wrong hash for
// the saved block would otherwise restart the whole replay from the start height. A block buried this deep cannot be reorganized,
// so the check is made in full only near the tip and now and then below it, and when no source can be asked it says so (null)
// and the loop waits and tries again instead of restarting the process.
let checks=0,lastProgress=0;
async function bitcoinReorged() {
  if(!meta.hash) return false;
  if(knownTip&&meta.height<knownTip-200&&checks++%100!==0) return false;
  const answers=[];
  for(const m of bitcoin.bases) {
    try{const r=await bitcoin.askOne(m,`/block-height/${meta.height}`,{signal:AbortSignal.timeout(20000)});if(r&&r.ok){const h=(await r.text()).trim();if(/^[0-9a-f]{64}$/.test(h)) answers.push(h);}}catch{}
  }
  if(!answers.length) return null;
  if(answers.every(h=>h===meta.hash)) return false;
  if(answers.every(h=>h!==meta.hash)&&answers.length>=Math.min(2,bitcoin.bases.length)) return true;
  throw new Error(`Bitcoin sources disagree about block ${meta.height}; waiting for them to agree`);
}
for(;;) {
  try {
    const reorged=await bitcoinReorged();
    if(reorged===null) {
      scanError=`no Bitcoin source answered for block ${meta.height} (${bitcoin.describe()})`;console.error('[state]',scanError);
      await new Promise(r=>setTimeout(r,30000));continue;
    }
    if(reorged||(meta.ethHash&&(await ethBlock(meta.ethHeight)).hash!==meta.ethHash)) {
      meta={epoch:randomBytes(16).toString('hex'),height:start-1,hash:'',start,revision:REVISION};
      await save();
      // Restart clears all upstream module-level state and cached derived data.
      process.exit(75);
    }
    const next=await driver.transaction(async()=>{
      const saved=JSON.parse((await driver.get(metaNamespace,network)).value.toString());
      if(saved.epoch!==meta.epoch||saved.height!==meta.height||saved.hash!==meta.hash) throw new Error('State changed in another worker');
      if(Number(BigInt(await ethRpc('eth_chainId')))!==(network==='mainnet'?1:11155111)) throw new Error('Wrong Ethereum replay network');
      const ethSafe=Number(BigInt(await ethRpc('eth_blockNumber')))-36;
      const ethFrom=await crossouts.consumer.nextFromBlock(network,crossouts.deployment.pool,crossouts.deployment.deployBlock);
      let ethHeight=meta.ethHeight,ethHash=meta.ethHash;
      if(ethFrom<=ethSafe) {
        ethHeight=Math.min(ethFrom+127,ethSafe);ethHash=(await ethBlock(ethHeight)).hash;
        const progress=await crossouts.consumer.scan({network,pool:crossouts.deployment.pool,tipHeight:ethHeight+36,fromBlock:ethFrom});
        if(progress.rpcFailed||progress.advancedCursorTo!==ethHeight+1||(await ethBlock(ethHeight)).hash!==ethHash) throw new Error('Cross-out replay failed or reorganized');
      }
      // Finish discovering finalized cross-outs before judging Bitcoin claims.
      if(ethHeight<ethSafe) {
        const next={...meta,ethHeight,ethHash,lastSeq:await driver.lastSequence(meta.epoch),updatedAt:new Date().toISOString()};
        await driver.put(metaNamespace,network,Buffer.from(JSON.stringify(next)));return next;
      }
      const response=await request(`/scan?network=${network}`,'POST');
      if(!response.ok) throw new Error(`Upstream scan HTTP ${response.status}`);
      const height=Number(await env.REGISTRY_KV.get(cursorKey));
      const hash=await getText(`/block-height/${height}`);
      if(!/^[0-9a-f]{64}$/.test(hash)||!Number.isSafeInteger(height)||height<meta.height) throw new Error('Invalid upstream scan checkpoint');
      if((meta.hash&&!(knownTip&&meta.height<knownTip-200)&&await getText(`/block-height/${meta.height}`)!==meta.hash)||(meta.ethHash&&(await ethBlock(meta.ethHeight)).hash!==meta.ethHash)) throw new Error('Chain changed during state replay');
      const recordedHash=await env.REGISTRY_KV.get(network==='signet'?'meta:last_scanned_hash':`meta:last_scanned_hash:${network}`);
      if(recordedHash!==hash) throw new Error('Scanned block does not match canonical checkpoint');
      const pendingClaims=await env.REGISTRY_KV.list({prefix:`crossout-minted:${network}:`,limit:100,...(meta.crossoutRefreshCursor?{cursor:meta.crossoutRefreshCursor}:{})});
      for(const key of pendingClaims.keys) {
        const claim=await env.REGISTRY_KV.get(key.name,'json');
        if(claim?.status==='pending-reflection'&&claim.height<=height) {
          const refreshed=await request(`/assets/hint?network=${network}`,'POST',{reveal_txid:claim.txid,reveal_vout:0});
          if(!refreshed.ok) throw new Error('Pending cross-out refresh unavailable');
        }
      }
      if(ethHash&&(await ethBlock(ethHeight)).hash!==ethHash) throw new Error('Ethereum changed during Bitcoin state replay');
      const next={...meta,height,hash,ethHeight,ethHash,crossoutRefreshCursor:pendingClaims.list_complete?null:pendingClaims.cursor,lastSeq:await driver.lastSequence(meta.epoch),updatedAt:new Date().toISOString()};
      await driver.put(metaNamespace,network,Buffer.from(JSON.stringify(next)));
      return next;
    });
    meta=next;scanError=null;
    // One line a minute while it works: where the replay is, and how each Bitcoin host is doing.
    if(Date.now()-lastProgress>=60000) {
      lastProgress=Date.now();
      console.log(`[state] replayed to block ${meta.height}${knownTip?` of ${knownTip-confirmations} (${Math.max(0,knownTip-confirmations-meta.height)} to go)`:''}; ${bitcoin.describe()}`);
    }
  } catch(e) {
    scanError=e.message;console.error('[state]',e.message);
    // Any upstream caches may describe rolled-back writes. Restart before retry.
    await new Promise(r=>setTimeout(r,10000));process.exit(75);
  }
  await new Promise(r=>setTimeout(r,Number(process.env.SCAN_POLL_MS||10000)));
}
