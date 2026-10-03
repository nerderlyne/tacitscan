import { secp256k1 } from '@noble/curves/secp256k1';
import * as upstream from './vendor/bitcoin-decoders.js';
import { CURRENT_OPS, jsonSafe, type ModernOpcode } from './protocol.js';

export interface ModernEnvelope {
  opcode: ModernOpcode;
  modern: true;
  payload: Uint8Array;
  assetId?: string;
  n?: number;
  fields: Record<string, unknown>;
  commitments: {vout:number; commitmentC:Uint8Array; encryptedAmount:Uint8Array | null}[];
}
const hex = (b:Uint8Array) => Buffer.from(b).toString('hex');
class Reader {
  off = 1;
  constructor(readonly b:Uint8Array) {}
  take(n:number) { if (!Number.isSafeInteger(n) || n < 0 || this.off+n > this.b.length) throw new Error('truncated payload'); const v=this.b.slice(this.off,this.off+n); this.off+=n; return v; }
  h(n=32) {return hex(this.take(n));}
  u(n:number) {let v=0n; const b=this.take(n); for(let i=n-1;i>=0;i--) v=(v<<8n)|BigInt(b[i]!); return v;}
  byte() {return Number(this.u(1));}
  word() {return Number(this.u(2));}
  point() {const b=this.take(33); secp256k1.ProjectivePoint.fromHex(b).assertValidity(); return b;}
  end() {if(this.off!==this.b.length) throw new Error('trailing bytes');}
}
const decoders: Record<number,(p:Uint8Array)=>unknown> = {
  0x2d:upstream.decodeTLpAddPayload, 0x2e:upstream.decodeTLpRemovePayload,
  0x2f:upstream.decodeTSwapBatchPayload, 0x31:upstream.decodeTProtocolFeeClaimPayload,
  0x32:upstream.decodeTSwapVarPayload, 0x33:upstream.decodeTSwapRoutePayload,
  0x34:upstream.decodeTFarmInitPayload, 0x35:upstream.decodeTLpBondPayload,
  0x36:upstream.decodeTLpUnbondPayload, 0x3b:upstream.decodeTLpHarvestPayload,
  0x3e:upstream.decodeTFarmRefundPayload, 0x5b:upstream.decodePreauthBidPayload, 0x5c:upstream.decodePreauthBidVarPayload,
};

// This decodes public data only. State-dependent and cryptographic acceptance
// is supplied independently by the reference indexer, never by this function.
export function decodeModern(payload:Uint8Array):ModernEnvelope | undefined {
  const op=payload[0]!;
  const name=op===0x2b && payload.length===161 ? 'T_POOL_BRIDGE_BURN' : CURRENT_OPS[op as keyof typeof CURRENT_OPS];
  if(!name) return undefined;
  const r=new Reader(payload);
  const out:ModernEnvelope={opcode:name,modern:true,payload,fields:{},commitments:[]};
  const f=out.fields;
  if(decoders[op]) {
    const decoded=decoders[op]!(payload);
    if(!decoded) throw new Error(`malformed ${name}`);
    out.fields=jsonSafe(decoded);
    out.assetId=typeof out.fields.asset_id==='string' ? out.fields.asset_id : undefined;
    // Bid outputs are public commitments; change is interleaved with BTC outputs.
    if(op===0x5b || op===0x5c) {
      const outputs=out.fields.outputs as {commitment:string}[];
      const partial=op===0x5c && BigInt(String(out.fields.fill_amount))<BigInt(String(out.fields.max_fill));
      out.commitments=outputs.map((o,i)=>({vout:i===0?0:partial?4:3,commitmentC:Buffer.from(o.commitment,'hex'),encryptedAmount:null}));
      out.n=outputs.length;
    }
    return out;
  }
  if([0x39,0x3c,0x3d].includes(op)) {
    if(op===0x39) f.targetChainBinding=r.h();
    out.assetId=r.h();
    if(op!==0x39) f.assetInputCount=r.byte();
    if(op===0x3d) {
      if(f.assetInputCount!==1) throw new Error('variable trade requires one asset input');
      f.kernelSig=r.h(64); out.n=r.byte();
      if(out.n!==2) throw new Error('variable trade requires two outputs');
    } else {f.kernelSig=r.h(64); out.n=r.byte();}
    if(![1,2,4,8].includes(out.n!)) throw new Error('invalid output count');
    if(op!==0x39 && Number(f.assetInputCount)<1) throw new Error('invalid input count');
    for(let i=0;i<out.n!;i++) out.commitments.push({vout:op===0x3d?i*2:i,commitmentC:r.point(),encryptedAmount:r.take(8)});
    f.rangeproof=r.h(r.word());
  } else if(op===0x2b) {
    out.assetId=r.h(); f.poolRoot=r.h(); f.nullifier=r.h(); f.destinationCommitment=r.h(); f.targetChainBinding=r.h();
  } else if(op===0x65) {
    out.assetId=r.h(); f.claimId=r.h(); f.cx=r.h(); f.cy=r.h(); f.owner=r.h();
    const point=secp256k1.ProjectivePoint.fromHex('04'+f.cx+f.cy); point.assertValidity();
    out.commitments=[{vout:0,commitmentC:point.toRawBytes(true),encryptedAmount:null}]; out.n=1;
  } else if(op===0x66) {
    out.assetId=r.h(); f.lockVout=Number(r.u(4)); f.cx=r.h(); f.cy=r.h(); f.sigRx=r.h(); f.sigRy=r.h(); f.sigZ=r.h();
  } else if(op===0x67) {
    f.lockTxid=r.h(); f.lockVout=Number(r.u(4)); f.valueSats=r.u(8).toString(); f.kernelSig=r.h(64);
  } else if(op===0x68) {
    if(payload.length!==201) throw new Error('BTC call must be 201 bytes');
    f.executor=r.h(20); f.target=r.h(20); f.calldataHash=r.h(); f.callerPubkey=r.h(); f.nonce=r.h(); f.signature=r.h(64);
  } else if(op===0x69) {
    f.messageId=r.h(); f.namespace=r.h(); f.sender=r.h(20);
    const chain=r.take(2); f.destChain=(chain[0]!<<8)|chain[1]!;
    f.payloadHash=r.h(); const len=r.word(); if(len>1024) throw new Error('message too large'); f.message=r.h(len);
  } else if(op===0x6e) {
    f.wrap=r.byte(); f.count=r.byte(); const len=r.word();
    if(![1,2].includes(Number(f.wrap)) || !Number(f.count) || len<1 || len>4096) throw new Error('invalid aggregate');
    f.proof=r.h(len); f.acceptance='unverified-extension';
  } else if(op===0x6c || op===0x6d) {
    out.assetId=r.h();
    const boundary=()=>({secpCommitment:hex(r.point()),bjjCommitment:r.h(),sigma:r.h(169),rangeproof:r.h(591)});
    const field=()=>{const b=r.take(32); let n=0n; for(let i=0;i<32;i++) n=(n<<8n)|BigInt(b[i]!); if(n===0n || n>=21888242871839275222246405745257275088548364400416034343698204186575808495617n) throw new Error('invalid field element'); return hex(b);};
    if(op===0x6d) {f.anchorHeight=Number(r.u(4)); f.bind=r.h(36);}
    const nIn=r.byte(); if(nIn<1 || nIn>(op===0x6c?8:2)) throw new Error('invalid input count'); f.inputCount=nIn;
    if(op===0x6d) f.nullifiers=Array.from({length:nIn},field);
    const nOut=r.byte(); if(nOut>3 || (op===0x6c && !nOut)) throw new Error('invalid output count');
    f.notes=Array.from({length:nOut},()=>({leaf:field(),ephemeralKey:hex(r.point()),encryptedNote:r.h(24)}));
    if(op===0x6c) {f.boundary=boundary(); f.kernelSig=r.h(64);}
    else {
      const hasExit=r.byte(); if(hasExit>1) throw new Error('invalid exit flag');
      if(hasExit) {const vout=Number(r.u(4)); f.exit={vout,destinationScriptHash:r.h(),boundary:boundary()};}
      if(!hasExit && !nOut) throw new Error('spend creates no outputs');
      const hasWant=r.byte(); if(hasWant>1) throw new Error('invalid want flag');
      if(hasWant) f.want={vout:Number(r.u(4)),valueSats:r.u(8).toString(),scriptHash:r.h()};
    }
    const len=r.word(); if(len>4096) throw new Error('proof too large'); f.proof=r.h(len); f.proofSystem='halo2-kzg-bn254';
  }
  r.end();
  out.fields={...f,assetId:out.assetId,outputCount:out.n,outputs:jsonSafe(out.commitments)};
  return out;
}
