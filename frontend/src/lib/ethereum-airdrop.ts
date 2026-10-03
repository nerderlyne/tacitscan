import { concatHex, createPublicClient, encodeAbiParameters, http, isAddress, keccak256, parseAbi, type Hex } from 'viem';
export const AIRDROP_ADDRESS='0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8' as const;
export const AIRDROP_ROOT='0x27451b320d5aa9631f7a3fd8adcfa537db8d792dd49aad9ab0951af0c2986a10' as const;
const PIN='1b2eedde8490801c9ef4406020530059162e6d47';
const abi=parseAbi(['function MERKLE_ROOT() view returns (bytes32)','function isClaimed(uint256) view returns (bool)','function paused() view returns (bool)','function CLAIM_DEADLINE() view returns (uint256)']);
type Claim={index:number;amount:string;proof:Hex[]};
type Shard={root:string;claims:Record<string,Claim>};
const cache=new Map<string,Shard>();
export function verifyAllocation(address:Hex,claim:Claim,root:string):boolean {
  try {
    if(!Number.isSafeInteger(claim.index)||claim.index<0||!/^[0-9]+$/.test(claim.amount)||claim.proof.length>64) return false;
    let hash=keccak256(keccak256(encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'uint256'}],[BigInt(claim.index),address,BigInt(claim.amount)])));
    for(const sibling of claim.proof) {if(!/^0x[0-9a-f]{64}$/i.test(sibling)) return false;hash=keccak256(concatHex(BigInt(hash)<BigInt(sibling)?[hash,sibling]:[sibling,hash]));}
    return hash.toLowerCase()===root.toLowerCase();
  } catch {return false;}
}
async function shardFor(prefix:string):Promise<Shard> {
  if(cache.has(prefix)) return cache.get(prefix)!;
  for(const base of [`https://cdn.jsdelivr.net/gh/z0r0z/tacit@${PIN}/`,`https://raw.githubusercontent.com/z0r0z/tacit/${PIN}/`]) {
    try {
      const response=await fetch(`${base}dapp/airdrop/v1/proofs/${prefix}.json`,{signal:AbortSignal.timeout(8000)});
      if(!response.ok) continue;
      const text=await response.text(); if(text.length>250000) continue;
      const data=JSON.parse(text) as Shard;
      if(data.root!==AIRDROP_ROOT||!data.claims||typeof data.claims!=='object') continue;
      cache.set(prefix,data);return data;
    } catch { /* Try the second immutable copy. */ }
  }
  throw new Error('Published allocation data is unavailable. Please retry.');
}
export async function ethereumAllocation(raw:string) {
  if(!isAddress(raw)) throw new Error('Enter a valid Ethereum address.');
  const address=raw.toLowerCase() as Hex;
  const shard=await shardFor(address.slice(2,4));const claim=shard.claims[address];
  if(!claim) return {address,published:false,contract:AIRDROP_ADDRESS};
  if(!verifyAllocation(address,claim,AIRDROP_ROOT)) throw new Error('Allocation proof failed verification.');
  const result={address,published:true,amountWei:claim.amount,index:claim.index,proofVerified:true,root:AIRDROP_ROOT,contract:AIRDROP_ADDRESS};
  const rpc=process.env.EVM_RPC_URL_1 || process.env.RPC_ETH;
  if(!rpc) return {...result,chainStatus:'unavailable',message:'Allocation verified; current claim status is unavailable.'};
  try {
    const client=createPublicClient({transport:http(rpc,{timeout:8000,retryCount:1})});
    if(await client.getChainId()!==1) throw new Error('wrong chain');
    const head=await client.getBlock();const blockNumber=head.number;
    const [root,claimed,paused,deadline]=await Promise.all([
      client.readContract({address:AIRDROP_ADDRESS,abi,functionName:'MERKLE_ROOT',blockNumber}),
      client.readContract({address:AIRDROP_ADDRESS,abi,functionName:'isClaimed',args:[BigInt(claim.index)],blockNumber}),
      client.readContract({address:AIRDROP_ADDRESS,abi,functionName:'paused',blockNumber}),
      client.readContract({address:AIRDROP_ADDRESS,abi,functionName:'CLAIM_DEADLINE',blockNumber}),
    ]);
    if(root!==AIRDROP_ROOT) throw new Error('deployed root mismatch');
    if((await client.getBlock({blockNumber})).hash!==head.hash) throw new Error('chain changed');
    return {...result,chainStatus:claimed?'claimed':paused?'paused':head.timestamp>deadline?'expired':'unclaimed',deadline:deadline.toString(),asOfBlock:blockNumber.toString()};
  } catch {return {...result,chainStatus:'unavailable',message:'Allocation verified; current claim status is unavailable.'};}
}
