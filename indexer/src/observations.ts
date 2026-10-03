import { keccak256,concatHex,type Hex } from 'viem';
import { outpointKey } from './bridge-links.js';
import { sql } from 'drizzle-orm';
import type { DB } from './db.js';
import type { EsploraTx } from './esplora.js';
import { tryDecodeFromWitness, hexToBytes } from './envelope.js';
import { DECODER_VERSION, jsonSafe, protocolFamily, supportStatus } from './protocol.js';
import type { TxCtx } from './handlers.js';

export function decodeTransaction(tx:EsploraTx) {
  const items=[];
  for(let inputIndex=0;inputIndex<tx.vin.length;inputIndex++) {
    const vin=tx.vin[inputIndex]!;
    if(vin.is_coinbase) continue;
    const result=tryDecodeFromWitness(vin.witness);
    if(!result) continue;
    const op=result.rawPayload?.[0];
    // Later inputs are only meaningful for shielded-pool envelopes; preserve
    // misplaced shields too, with placement recorded rather than credited.
    if(inputIndex>0 && ![0x6c,0x6d,0x6e].includes(op!)) continue;
    items.push({inputIndex,result,rawScript:hexToBytes(vin.witness![1]!)});
  }
  return items;
}
export async function persistObservations(db:DB, tx:EsploraTx, ctx:TxCtx | {network:string}, mempool=false) {
  const items=decodeTransaction(tx);
  const block='height' in ctx?ctx:null;
  for(const {inputIndex,result,rawScript} of items) {
    const env=result.ok?result.envelope:null;
    const opcode=env?.opcode??'UNKNOWN';
    const asset=env && 'assetId' in env?env.assetId:null;
    const support=supportStatus(opcode);
    const placement=inputIndex>0 && (opcode==='T_BTC_SHIELD' || items.some(i=>i.inputIndex===0 && i.result.ok && i.result.envelope.opcode==='T_BTC_SHIELD'));
    const validation=placement?'rejected-placement':support==='reserved'?'reserved':support==='unverified-extension'?'unverified-extension':'unchecked';
    const decoded=env?jsonSafe('modern' in env?env.fields:env):{};
    if(env?.opcode==='T_BTC_CALL') decoded.callId=keccak256(concatHex([('0x'+decoded.callerPubkey) as Hex,('0x'+decoded.nonce) as Hex]));
    if(env?.opcode==='T_CBTC_LOCK') decoded.outpoint=outpointKey(Buffer.from(tx.txid,'hex').reverse().toString('hex'),decoded.lockVout);
    if(env?.opcode==='T_CBTC_REDEEM') decoded.outpoint=outpointKey(decoded.lockTxid,decoded.lockVout);
    await db.execute(sql`INSERT INTO protocol_envelopes
      (network,txid,input_index,opcode,opcode_byte,family,support,asset_id,block_height,block_hash,tx_index,chain_status,decoded,raw_payload,raw_script,carrier,decode_status,decode_error,validation_status,decoder_version)
      VALUES (${ctx.network},${tx.txid},${inputIndex},${opcode},${result.rawPayload?.[0]??-1},${protocolFamily(opcode)},${support},${asset??null},${block?.height??null},${block?.blockHash??null},${block?.txIndex??null},${mempool?'mempool':'confirmed'},${JSON.stringify(decoded)}::jsonb,${Buffer.from(result.rawPayload??[])},${Buffer.from(rawScript)},${JSON.stringify(tx)}::jsonb,${result.ok?'decoded':'malformed'},${result.ok?null:result.reason},${validation},${DECODER_VERSION})
      ON CONFLICT(network,txid,input_index) DO UPDATE SET
      opcode=EXCLUDED.opcode,opcode_byte=EXCLUDED.opcode_byte,family=EXCLUDED.family,support=EXCLUDED.support,
      asset_id=EXCLUDED.asset_id,block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash,tx_index=EXCLUDED.tx_index,
      chain_status=EXCLUDED.chain_status,decoded=EXCLUDED.decoded,raw_payload=EXCLUDED.raw_payload,raw_script=EXCLUDED.raw_script,
      carrier=EXCLUDED.carrier,decode_status=EXCLUDED.decode_status,decode_error=EXCLUDED.decode_error,
      validation_status=EXCLUDED.validation_status,validation_evidence=NULL,decoder_version=EXCLUDED.decoder_version
      WHERE EXCLUDED.chain_status='confirmed' OR protocol_envelopes.chain_status <> 'confirmed'`);
    if(mempool || !block || !env || placement) continue;
    if((inputIndex===0 || env.opcode==='T_BTC_SPEND') && support!=='reserved' && support!=='unverified-extension') {
      for(let vout=0;vout<tx.vout.length;vout++) {
        await db.execute(sql`INSERT INTO protocol_validation_jobs(network,txid,vout,block_height,block_hash)
          VALUES(${ctx.network},${tx.txid},${vout},${block.height},${block.blockHash})
          ON CONFLICT(network,txid,vout) DO UPDATE SET block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash,status='pending',evidence=NULL,next_attempt_at=now()`);
      }
    }

    // Commitment observations are not accepted balances. Only unambiguous
    // asset/output mappings are stored here; reference replay supplies validity.
    let outputs:{vout:number;commitmentC:Uint8Array;encryptedAmount:Uint8Array|null}[]=[];
    if('modern' in env) outputs=env.commitments;
    else if('outputs' in env && ['CXFER','T_AXFER','T_CXFER_BPP','T_AXFER_VAR','T_BURN'].includes(env.opcode)) outputs=env.outputs as typeof outputs;
    if(env.opcode==='T_AXFER_VAR') outputs=outputs.map((o,i)=>({...o,vout:i*2}));
    if(asset) for(const o of outputs) {
      if(!tx.vout[o.vout]) continue;
      await db.execute(sql`INSERT INTO protocol_outputs(network,txid,vout,asset_id,commitment,encrypted_amount,block_height,block_hash)
        VALUES(${ctx.network},${tx.txid},${o.vout},${asset},${Buffer.from(o.commitmentC).toString('hex')},${o.encryptedAmount?Buffer.from(o.encryptedAmount).toString('hex'):null},${block.height},${block.blockHash})
        ON CONFLICT(network,txid,vout) DO UPDATE SET asset_id=EXCLUDED.asset_id,commitment=EXCLUDED.commitment,encrypted_amount=EXCLUDED.encrypted_amount,block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash,validation_status='unchecked'`);
    }
  }
  return items;
}

// Check every Bitcoin transaction, including transactions without envelopes.
export async function persistTrackedSpends(db:DB, tx:EsploraTx, ctx:TxCtx) {
  const inputs=tx.vin.filter(v=>!v.is_coinbase).map(v=>({txid:v.txid,vout:v.vout}));
  if(!inputs.length) return;
  await db.execute(sql`INSERT INTO protocol_spends(network,source_txid,source_vout,spending_txid,block_height,block_hash)
    SELECT ${ctx.network},i.txid,i.vout,${ctx.txid},${ctx.height},${ctx.blockHash}
    FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) AS i(txid text,vout integer)
    WHERE EXISTS(SELECT 1 FROM commitments c WHERE c.network=${ctx.network} AND c.txid=i.txid AND c.vout=i.vout)
       OR EXISTS(SELECT 1 FROM protocol_outputs o WHERE o.network=${ctx.network} AND o.txid=i.txid AND o.vout=i.vout)
    ON CONFLICT(network,source_txid,source_vout) DO UPDATE SET spending_txid=EXCLUDED.spending_txid,block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash`);
}
