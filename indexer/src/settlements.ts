import { decodeAbiParameters,decodeFunctionData,decodeFunctionResult,keccak256,concatHex,toHex,type Abi,type AbiParameter, type Hex } from 'viem';
import { makeConfidentialLockScan } from './vendor/confidential-lock-scan.js';
import publicPoolAbi from './vendor/public-pool.json' with {type:'json'};
import publicAmmAbi from './vendor/public-amm.json' with {type:'json'};
import publicValuesAbi from './vendor/public-values.json' with {type:'json'};
import { jsonSafe } from './protocol.js';
import type { makeRpc,EvmLog } from './evm.js';
const decoder=makeConfidentialLockScan({pool:null});
const SETTLE='0x717fd7f2';
export interface Trace {type?:string;to?:string;input?:string;output?:string;error?:string;calls?:Trace[];}
export interface Settlement {callIndex:number;authority:string;calldata:string;publicValues:unknown;memos:unknown;error:string|null;}
export function successfulPoolCalls(trace:Trace,pool:string):string[] {
  const result:string[]=[];
  const visit=(call:Trace,depth:number)=>{
    if(depth>1024) throw new Error('Call trace depth exceeded');
    if(call.error) return;
    if(call.type==='CALL'&&call.to?.toLowerCase()===pool.toLowerCase()&&call.input?.startsWith(SETTLE)) result.push(call.input);
    for(const child of call.calls??[]) visit(child,depth+1);
  };
  visit(trace,0);return result;
}
function interpret(call:{publicValues:string;memos:unknown},index:number,authority:string,calldata:string):Settlement {
  try {
    const [values]=decodeAbiParameters(publicValuesAbi as AbiParameter[],call.publicValues as Hex);
    return {callIndex:index,authority,calldata,publicValues:jsonSafe(values),memos:call.memos,error:null};
  } catch {
    return {callIndex:index,authority,calldata,publicValues:{raw:call.publicValues},memos:call.memos,error:'Unsupported public-values encoding'};
  }
}
function interpretAmm(input:string,output:string|undefined,index:number,authority:string):Settlement|null {
  try {
    const abi=publicAmmAbi as Abi;
    const decoded=decodeFunctionData({abi,data:input as Hex});
    const method=publicAmmAbi.find(f=>f.name===decoded.functionName)!;
    const args=Object.fromEntries(method.inputs.map((p,i)=>[p.name,decoded.args?.[i]]));
    const assetA=String(args.assetA??args.assetIn),assetB=String(args.assetB??args.assetOut);
    const [lo,hi]=BigInt(assetA)<BigInt(assetB)?[assetA,assetB]:[assetB,assetA];
    const poolId=keccak256(concatHex([lo as Hex,hi as Hex,toHex(BigInt(String(args.feeBps)),{size:32})]));
    let result:unknown=null;
    if(output&&output!=='0x') result=decodeFunctionResult({abi,functionName:decoded.functionName,data:output as Hex});
    return {callIndex:index,authority,calldata:input,publicValues:jsonSafe({publicAmm:[{functionName:decoded.functionName,poolId,args,result}]}),memos:[],error:null};
  } catch {return null;}
}
function interpretPool(input:string,output:string|undefined,index:number,authority:string):Settlement|null {
  if(input.startsWith(SETTLE)) return interpret(decoder.decodeSettleCalldata(input),index,authority,input);
  let decoded:{functionName:string;args?:readonly unknown[]};
  try {decoded=decodeFunctionData({abi:publicPoolAbi as Abi,data:input as Hex});} catch {return null;}
  const method=publicPoolAbi.find(f=>f.name===decoded.functionName)!;
  const args=Object.fromEntries(method.inputs.map((p,i)=>[p.name,decoded.args?.[i]]));
  const assetA=String(args.assetA) as Hex,assetB=String(args.assetB) as Hex;
  const [lo,hi]=BigInt(assetA)<BigInt(assetB)?[assetA,assetB]:[assetB,assetA];
  const preimage:Hex[]=[lo,hi,toHex(BigInt(String(args.feeBps)),{size:32})];
  if(args.protocolFeeBps&&BigInt(String(args.protocolFeeBps))!==0n) preimage.push(toHex(BigInt(String(args.rcptPrefix)),{size:1}),String(args.rcptX) as Hex,toHex(BigInt(String(args.protocolFeeBps)),{size:32}));
  const poolId=keccak256(concatHex(preimage));
  const record=decoded.functionName==='createPairAndSettle'?interpret({publicValues:String(args.publicValues),memos:jsonSafe(args.memos)},index,authority,input):{callIndex:index,authority,calldata:input,publicValues:{},memos:[],error:null};
  const {publicValues:_,proofBytes:__,memos:___,...publicArgs}=args;
  record.publicValues={...(record.publicValues as object),publicAmm:jsonSafe([{functionName:decoded.functionName,poolId,args:publicArgs,result:output??null}])};
  return record;
}
export interface TracedTransaction {trace:Trace;blockHash:string;blockHeight:number;}
export async function readSettlements(rpc:ReturnType<typeof makeRpc>,pool:string,logs:EvmLog[],amm?:string,traces=new Map<string,TracedTransaction>()) {
  const found=new Map<string,Settlement[]>();
  // Token logs also discover public-AMM transactions with no pool event.
  for(const txid of new Set([...logs.map(l=>l.transactionHash),...traces.keys()])) {
    const tx=await rpc<{to:string|null;input:string;blockHash:string}>('eth_getTransactionByHash',[txid]);
    if(tx.blockHash!==(traces.get(txid)?.blockHash??logs.find(l=>l.transactionHash===txid)?.blockHash)) throw new Error('Settlement transaction changed block');
    const records:Settlement[]=[];
    const direct=tx.to?.toLowerCase()===pool;
    let traced=false;
    if(process.env.EVM_REQUIRE_CALL_TRACES==='true'||!direct) {
      try {
        const trace=traces.get(txid)?.trace??await rpc<Trace>('debug_traceTransaction',[txid,{tracer:'callTracer',timeout:'15s'}]);
        if(!trace||trace.input!==tx.input||(tx.to ? trace.to?.toLowerCase()!==tx.to.toLowerCase()||trace.type!=='CALL' : !['CREATE','CREATE2'].includes(trace.type??''))) throw new Error('Invalid transaction trace');
        const visit=(call:Trace,depth:number)=>{
          if(depth>1024) throw new Error('Call trace exceeds EVM depth');
          if(call.error) return;
          if(call.type==='CALL'&&call.to?.toLowerCase()===pool&&call.input) {
            const value=interpretPool(call.input,call.output,records.length,'successful-call-trace');if(value) records.push(value);
          }
          else if(call.type==='CALL'&&amm&&call.to?.toLowerCase()===amm&&call.input) {
            const value=interpretAmm(call.input,call.output,records.length,'successful-call-trace');if(value) records.push(value);
          }
          for(const child of call.calls??[]) visit(child,depth+1);
        };
        visit(trace,0);traced=true;
      } catch {records.length=0;if(process.env.EVM_REQUIRE_CALL_TRACES==='true') throw new Error('Required protocol call trace unavailable');}
    }
    if(!traced) {
      if(direct) {const value=interpretPool(tx.input,undefined,0,'direct-pool-call');if(value) records.push(value);}
      else if(amm&&tx.to?.toLowerCase()===amm) {const value=interpretAmm(tx.input,undefined,0,'direct-pool-call');if(value) records.push(value);}
      else {
        // Failed inner calls may appear here; these candidates are never accepted.
        let candidates:{publicValues:string;memos:unknown}[]=[];
        try {
          const selector=tx.input.slice(2,10).toLowerCase();
          candidates=['fcccb833','e2b28725'].includes(selector)?decoder.decodeRelaySettleCalldata(tx.input):decoder.decodeNestedSettles(tx.input);
        } catch { /* Raw event evidence remains available. */ }
        records.push(...candidates.map((c,i)=>interpret(c,i,'unconfirmed-calldata',tx.input)));
      }
    }
    if(records.length) found.set(txid,records);
  }
  return found;
}

// Full-block traces discover successful public-AMM calls even when neither leg
// emits a watched-token log. Log-only discovery cannot establish full parity.
export async function readBlockCallTraces(rpc:ReturnType<typeof makeRpc>,from:number,to:number,pool:string,amm:string|undefined,logs:EvmLog[]) {
  const found=new Map<string,TracedTransaction>();
  const watched=new Set(logs.map(l=>l.transactionHash as string));
  function relevant(call:Trace,depth=0):boolean {
    if(depth>1024) throw new Error('Trace exceeds EVM call depth');
    if(call.error) return false;
    if(call.type==='CALL'&&(call.to?.toLowerCase()===pool||call.to?.toLowerCase()===amm)) return true;
    return (call.calls??[]).some(c=>relevant(c,depth+1));
  }
  for(let height=from;height<=to;height++) {
    const tag=toHex(height);
    const block=await rpc<{hash:string;transactions:string[]}>('eth_getBlockByNumber',[tag,false]);
    const traces=await rpc<{txHash?:string;result?:Trace;error?:string}[]>('debug_traceBlockByNumber',[tag,{tracer:'callTracer',timeout:'15s'}]);
    if(!Array.isArray(traces)||traces.length!==block.transactions.length) throw new Error('Incomplete block trace');
    for(let i=0;i<traces.length;i++) {
      const item=traces[i]!,txid=block.transactions[i]!;
      if(item.error||!item.result||!['CALL','CREATE','CREATE2'].includes(item.result.type??'')||(item.txHash&&item.txHash!==txid)) throw new Error('Invalid block trace');
      if(watched.has(txid)||relevant(item.result)) found.set(txid,{trace:item.result,blockHash:block.hash,blockHeight:height});
    }
    if((await rpc<{hash:string}>('eth_getBlockByNumber',[tag,false])).hash!==block.hash) throw new Error('Block changed during trace discovery');
  }
  return found;
}
