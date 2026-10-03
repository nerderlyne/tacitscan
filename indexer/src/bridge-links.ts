import { keccak256,concatHex,toHex,type Hex } from 'viem';
import { sql } from 'drizzle-orm';
import { secp256k1 } from '@noble/curves/secp256k1';
import { db } from './db.js';
const word=(s:string)=>('0x'+s.replace(/^0x/,'')) as Hex;
export function publicNoteNullifier(asset:string,cx:string,cy:string,authKey:string,binding?:string) {
  const fields=[word(asset),word(cx),word(cy),word(authKey)];
  if(binding) fields.push(word(binding));
  fields.push(toHex(binding?'tacit-btc-note-bound':'tacit-btc-note-v1'));
  return keccak256(concatHex([keccak256(concatHex(fields)),toHex('spent')]));
}
export function bridgeBurnIdentities(input:{asset:string;commitment:string;authKey:string;bound:boolean;txid:string;vout:number;target:string;nullifier:string}) {
  const affine=secp256k1.ProjectivePoint.fromHex(input.commitment).toAffine();
  const fields=[word(input.asset),toHex(affine.x,{size:32}),toHex(affine.y,{size:32}),word(input.authKey)];
  if(input.bound) fields.push(word(input.target));
  fields.push(toHex(input.bound?'tacit-btc-note-bound':'tacit-btc-note-v1'));
  const leaf=keccak256(concatHex(fields));
  const txid=word(Buffer.from(input.txid,'hex').reverse().toString('hex'));
  const depositLeaf=keccak256(concatHex([word(input.asset),toHex(affine.x,{size:32}),toHex(affine.y,{size:32}),outpointKey(txid,input.vout)]));
  return ([{kind:1,leaf},{kind:2,leaf:depositLeaf}]).filter(s=>keccak256(concatHex([s.leaf,toHex('spent')]))===word(input.nullifier)).map(s=>keccak256(concatHex([toHex('tacit-bridge-burn-source-v1'),toHex(s.kind,{size:1}),txid,toHex(input.vout,{size:4}),s.leaf,word(input.target)])));
}
export function outpointKey(internalTxid:string,vout:number) {
  const bytes=Buffer.alloc(4);bytes.writeUInt32LE(vout);
  return keccak256(concatHex([word(internalTxid),word(bytes.toString('hex'))]));
}
export async function enrichBridgeLinks(network:string) {
  const rows=await db.execute<{txid:string;input_index:number;block_hash:string;decoded:Record<string,any>;asset_id:string;parent_txid:string;parent_vout:number;evidence:Record<string,any>;commitment:string}>(sql`
    SELECT e.txid,e.input_index,e.block_hash,e.decoded,e.asset_id,j.txid AS parent_txid,j.vout AS parent_vout,j.evidence,o.commitment
    FROM protocol_envelopes e JOIN protocol_validation_jobs j ON j.network=e.network AND j.txid=e.carrier->'vin'->1->>'txid' AND j.vout=(e.carrier->'vin'->1->>'vout')::integer
    JOIN protocol_outputs o ON o.network=j.network AND o.txid=j.txid AND o.vout=j.vout
    WHERE e.network=${network} AND e.chain_status='confirmed' AND e.opcode='T_POOL_BRIDGE_BURN' AND j.status='accepted'
      AND j.evidence->'note'->>'authKey' IS NOT NULL AND e.decoded->'bridgeBurnIds' IS NULL LIMIT 100`);
  for(const row of rows) {
    const note=row.evidence.note;
    if(row.asset_id!==note.asset) continue;
    const ids=bridgeBurnIdentities({asset:note.asset,commitment:row.commitment,authKey:note.authKey,bound:!!note.bound,txid:row.parent_txid,vout:row.parent_vout,target:row.decoded.targetChainBinding,nullifier:row.decoded.nullifier});
    if(!ids.length) continue;
    await db.execute(sql`UPDATE protocol_envelopes SET decoded=decoded||${JSON.stringify({bridgeBurnIds:ids,burnIdentitySource:'validated-source-outpoint',sourceValidationAt:row.evidence.checkedAt})}::jsonb WHERE network=${network} AND txid=${row.txid} AND input_index=${row.input_index} AND block_hash=${row.block_hash}`);
  }
}
