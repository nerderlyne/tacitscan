import { sql } from 'drizzle-orm';
import { keccak256,concatHex,toHex,decodeAbiParameters,encodeAbiParameters,type Hex } from 'viem';
import { db } from './db.js';
import type { makeRpc } from './evm.js';
const zero=('0x'+'00'.repeat(32)) as Hex;
const hash=(a:Hex,b:Hex)=>keccak256(concatHex([a,b]));
// The deployment's three independent depth-32 Keccak accumulators.
async function keccakTree(chain:number,address:string,tree:string,height:number) {
  const zeros:Hex[]=[zero],filled:Hex[]=[];
  for(let i=1;i<=32;i++) zeros.push(hash(zeros[i-1]!,zeros[i-1]!));
  let root=zeros[32]!,count=0n;
  for(;;) {
    const rows=await db.execute<{leaf_index:string;leaf:Hex}>(sql`SELECT leaf_index::text,leaf FROM protocol_note_entries WHERE chain_id=${chain} AND deployment=${address} AND tree=${tree} AND block_height<=${height} AND leaf_index>=${count.toString()}::numeric ORDER BY leaf_index::numeric LIMIT 1000`);
    for(const row of rows) {
      if(BigInt(row.leaf_index)!==count||!/^0x[0-9a-f]{64}$/i.test(row.leaf)) throw new Error(`${tree} leaf sequence is incomplete`);
      let index=count,node=row.leaf;
      for(let level=0;level<32;level++) {
        if((index&1n)===0n) {filled[level]=node;node=hash(node,zeros[level]!);}
        else node=hash(filled[level]!,node);
        index>>=1n;
      }
      root=node;count++;
    }
    if(rows.length<1000) return {root,count:count.toString()};
  }
}
export async function reconcileTrees(rpc:ReturnType<typeof makeRpc>,chain:number,address:string,kind:string,height:number) {
  const tag=toHex(height);
  const call=(signature:string,args:Hex='0x')=>rpc<Hex>('eth_call',[{to:address,data:keccak256(toHex(signature)).slice(0,10)+args.slice(2)},tag]);
  if(kind==='TacitEvmPool') {
    const root=await call('root()');
    const size=BigInt(await call('rootSize(bytes32)',root));
    const rows=await db.execute<{root:string;count:string}>(sql`SELECT decoded->>'newRoot' AS root,
      ((decoded->>'firstIndex')::numeric+CASE WHEN decoded->>'outLeaf0'<>${zero} OR decoded->>'outLeaf1'<>${zero} THEN 2 ELSE 0 END)::text AS count
      FROM protocol_events WHERE chain_id=${chain} AND address=${address} AND event_name='Transact' AND block_height<=${height} ORDER BY block_height DESC,log_index DESC LIMIT 1`);
    const counts=await db.execute<{count:string}>(sql`SELECT count(*)::text AS count FROM protocol_note_entries WHERE chain_id=${chain} AND deployment=${address} AND tree='evm-pool' AND block_height<=${height}`);
    return [{deployment:address,tree:'evm-pool',root,count:size.toString(),matches:BigInt(counts[0]!.count)===size&&(!rows[0]?size===0n:rows[0].root===root&&BigInt(rows[0].count)===size),method:'Groth16-accepted event root and insertion count'}];
  }
  if(kind!=='ConfidentialPool') return [];
  const results=[];
  // Slots pinned to this revision: dapp lock scanner uses 84/85; the CDP
  // fields precede its 32-slot frontier and known-root/spent maps (162/163).
  for(const [tree,countSlot,rootSlot] of [['note',null,null],['lock',84,85],['cdp',128,129]] as const) {
    const local=await keccakTree(chain,address,tree,height);
    const count=BigInt(countSlot===null?await call('nextLeafIndex()'):await rpc<Hex>('eth_getStorageAt',[address,toHex(countSlot),tag])).toString();
    const root=rootSlot===null?await call('currentRoot()'):await rpc<Hex>('eth_getStorageAt',[address,toHex(rootSlot),tag]);
    results.push({deployment:address,tree,...local,contractRoot:root,contractCount:count,matches:root===local.root&&count===local.count,method:'Keccak replay against pinned contract state'});
  }
  return results;
}
export async function readAmmReserves(rpc:ReturnType<typeof makeRpc>,chain:number,pool:string,height:number) {
  const ids=await db.execute<{id:Hex}>(sql`SELECT DISTINCT body->>'poolId' AS id FROM protocol_effects WHERE chain_id=${chain} AND deployment=${pool} AND block_height<=${height} AND body ? 'poolId'`);
  const pools:Record<string,unknown>={};
  for(const {id} of ids) {
    if(!/^0x[0-9a-f]{64}$/i.test(id)) continue;
    const data=concatHex([keccak256(toHex('pools(bytes32)')).slice(0,10) as Hex,encodeAbiParameters([{type:'bytes32'}],[id])]);
    const raw=await rpc<Hex>('eth_call',[{to:pool,data},toHex(height)]);
    const [initialized,assetA,assetB,reserveA,reserveB,feeBps,totalShares]=decodeAbiParameters([{type:'bool'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint32'},{type:'uint256'}],raw);
    pools[id]={initialized,assetA,assetB,reserveA:reserveA.toString(),reserveB:reserveB.toString(),feeBps,totalShares:totalShares.toString(),lpAssetId:keccak256(concatHex([id,toHex('lp')]))};
  }
  return pools;
}
