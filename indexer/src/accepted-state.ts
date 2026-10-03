import { enrichBridgeLinks,publicNoteNullifier } from './bridge-links.js';
import { sql } from 'drizzle-orm';
import { secp256k1 } from '@noble/curves/secp256k1';
import { db } from './db.js';
import { readJson } from './reference.js';
import { PROTOCOL_REVISION } from './protocol.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export async function runAcceptedState():Promise<never> {
  const network=process.env.BITCOIN_NETWORK??'mainnet';
  const pool=new URL(process.env.BTC_POOL_REFERENCE_URL!);
  const state=new URL(process.env.TACIT_REFERENCE_URL!);
  for(;;) {
    try {
      const status=await readJson(new URL('/tacitscan/status',state));
      if(status.network!==network||status.sourceRevision!==PROTOCOL_REVISION||typeof status.epoch!=='string'||status.error) throw new Error('Canonical state identity/availability mismatch');
      // Rebuilt upstream state invalidates the old proof decisions as one unit.
      await db.transaction(async t=>{
        await t.execute(sql`UPDATE protocol_outputs SET validation_status='unchecked' WHERE network=${network} AND EXISTS(SELECT 1 FROM protocol_validation_jobs j WHERE j.network=protocol_outputs.network AND j.txid=protocol_outputs.txid AND j.vout=protocol_outputs.vout AND j.evidence->>'epoch'<>${status.epoch})`);
        await t.execute(sql`UPDATE protocol_validation_jobs SET status='pending',evidence=NULL,next_attempt_at=now() WHERE network=${network} AND evidence->>'epoch'<>${status.epoch}`);
      });
      const jobs=await db.execute<{txid:string;vout:number;block_height:number;block_hash:string}>(sql`
        SELECT txid,vout,block_height,block_hash FROM protocol_validation_jobs
        WHERE network=${network} AND (status='pending' OR checked_at<now()-interval '1 day') AND next_attempt_at<=now() AND block_height<=${status.height}
        ORDER BY next_attempt_at,block_height,txid,vout LIMIT 50`);
      for(const job of jobs) {
        try {
          const verdict=await readJson(new URL(`/tacitscan/output/${job.txid}/${job.vout}`,pool),120_000);
          if(verdict.network!==network||verdict.sourceRevision!==PROTOCOL_REVISION||verdict.txid!==job.txid||verdict.vout!==job.vout||verdict.blockHash!==job.block_hash||verdict.epoch!==status.epoch) throw new Error('Verdict identity/checkpoint mismatch');
          if(!['accepted','rejected'].includes(verdict.decision)) throw new Error('Acceptance undecided');
          let commitment:string|null=null,noteNullifier:string|null=null;
          if(verdict.decision==='accepted') {
            if(!/^[0-9a-f]{64}$/.test(verdict.note?.asset??'')) throw new Error('Invalid accepted asset');
            commitment=secp256k1.ProjectivePoint.fromHex('04'+verdict.note.cx+verdict.note.cy).toHex(true);
            if(verdict.note.authKey) {
              let binding:string|undefined;
              if(verdict.note.bound) {
                const source=await db.execute<{binding:string}>(sql`SELECT decoded->>'targetChainBinding' AS binding FROM protocol_envelopes WHERE network=${network} AND txid=${job.txid} AND input_index=0 AND block_hash=${job.block_hash}`);
                binding=source[0]?.binding;if(!binding||!/^[0-9a-f]{64}$/.test(binding)) throw new Error('Bound note deployment unavailable');
              }
              noteNullifier=publicNoteNullifier(verdict.note.asset,verdict.note.cx,verdict.note.cy,verdict.note.authKey,binding);
            }
          }
          const evidence={...verdict,publicNoteNullifier:noteNullifier,source:pool.origin,provenance:'pinned-upstream-validator',stateHeight:status.height,checkedAt:new Date().toISOString()};
          await db.transaction(async t=>{
            const updated=await t.execute(sql`UPDATE protocol_validation_jobs SET status=${verdict.decision},evidence=${JSON.stringify(evidence)}::jsonb,checked_at=now(),last_error=NULL
              WHERE network=${network} AND txid=${job.txid} AND vout=${job.vout} AND block_hash=${job.block_hash} RETURNING txid`);
            if(!updated.length) return;
            if(commitment) await t.execute(sql`INSERT INTO protocol_outputs(network,txid,vout,asset_id,commitment,block_height,block_hash,validation_status)
              VALUES(${network},${job.txid},${job.vout},${verdict.note.asset},${commitment},${job.block_height},${job.block_hash},'accepted')
              ON CONFLICT(network,txid,vout) DO UPDATE SET asset_id=EXCLUDED.asset_id,commitment=EXCLUDED.commitment,block_height=EXCLUDED.block_height,block_hash=EXCLUDED.block_hash,validation_status='accepted'`);
            else await t.execute(sql`UPDATE protocol_outputs SET validation_status='rejected' WHERE network=${network} AND txid=${job.txid} AND vout=${job.vout} AND block_hash=${job.block_hash}`);
          });
        } catch(e) {
          await db.execute(sql`UPDATE protocol_validation_jobs SET next_attempt_at=now()+interval '60 seconds',last_error=${e instanceof Error?e.message.slice(0,300):'Validation unavailable'} WHERE network=${network} AND txid=${job.txid} AND vout=${job.vout} AND block_hash=${job.block_hash}`);
        }
      }
      await enrichBridgeLinks(network);
      await sleep(jobs.length?500:15000);
    } catch(e) {console.error('[accepted-state]',e instanceof Error?e.message:'unavailable');await sleep(15000);}
  }
}
