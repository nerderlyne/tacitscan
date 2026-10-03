import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { readJson } from './reference.js';
import { PROTOCOL_REVISION } from './protocol.js';
// Stream a complete immutable pool snapshot into a new generation. Publication
// is atomic: interrupted pagination cannot replace the last complete state.
export async function refreshPoolRecords(base:URL,network:string) {
  const status=await readJson(new URL('/tacitscan/status',base));
  if(status.network!==network||status.sourceRevision!==PROTOCOL_REVISION||!status.verifierEnabled||status.halted||status.lastError||!Number.isSafeInteger(status.height)) throw new Error('Verified pool state unavailable');
  const source=`btc-pool:${network}`;
  const anchor=await readJson(new URL(`/btc-pool/root/${status.height}`,base));
  const local=await db.execute<{block_hash:string}>(sql`SELECT block_hash FROM blocks WHERE network=${network} AND height=${status.height}`);
  if(!local[0]||local[0].block_hash!==anchor.blockHash) throw new Error('Pool checkpoint is not on the locally indexed chain');
  const existing=await db.execute<{body:Record<string,any>}>(sql`SELECT body FROM protocol_snapshots WHERE source=${source} AND resource='accepted-records'`);
  if(existing[0]?.body.blockHash===anchor.blockHash) {
    await db.execute(sql`UPDATE protocol_snapshots SET fetched_at=now(),error=NULL WHERE source=${source} AND resource='accepted-records'`);return;
  }
  const generation=randomUUID();
  try {
    const counts:Record<string,number>={};
    for(const kind of ['notes','nullifiers','exits','envelopes']) {
      let after=-1;counts[kind]=0;
      for(;;) {
        const url=new URL('/tacitscan/records',base);
        url.searchParams.set('kind',kind);url.searchParams.set('at',String(status.height));url.searchParams.set('after',String(after));
        const page=await readJson(url);
        if(page.network!==network||page.sourceRevision!==PROTOCOL_REVISION||page.blockHash!==anchor.blockHash||!Array.isArray(page.rows)||page.rows.length>1000) throw new Error('Pool page checkpoint mismatch');
        await db.transaction(async t=>{
          for(const row of page.rows) {
            if(!Number.isSafeInteger(row.rid)||row.rid<=after||!Number.isSafeInteger(row.height)||row.height>status.height) throw new Error('Invalid pool sequence');
            await t.execute(sql`INSERT INTO protocol_reference_records(source,generation,kind,record_key,body,block_height) VALUES(${source},${generation},${kind},${String(row.rid)},${JSON.stringify(row)}::jsonb,${row.height})`);
          }
        });
        counts[kind]+=page.rows.length;
        if(page.complete===true) break;
        if(!Number.isSafeInteger(page.next)||page.next<=after) throw new Error('Pool pagination stalled');
        after=page.next;
      }
    }
    if(counts.notes!==status.leafCount) throw new Error('Pool note count does not match verified checkpoint');
    const end=await readJson(new URL(`/btc-pool/root/${status.height}`,base));
    if(end.blockHash!==anchor.blockHash||end.root!==anchor.root) throw new Error('Pool reorganized during import');
    const evidence={generation,network,height:status.height,blockHash:anchor.blockHash,root:anchor.root,counts,startHeight:status.startHeight,confirmations:status.confirmations,source:base.origin,sourceRevision:PROTOCOL_REVISION,proofSystem:status.proofSystem,vkHash:status.vkHash,provenance:'pinned-upstream-replay'};
    await db.transaction(async t=>{
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${network}),81420)`);
    const canonical=await t.execute<{block_hash:string}>(sql`SELECT block_hash FROM blocks WHERE network=${network} AND height=${status.height}`);
      if(canonical[0]?.block_hash!==anchor.blockHash) throw new Error('Local chain changed during import');
      await t.execute(sql`INSERT INTO protocol_snapshots(source,resource,body) VALUES(${source},'accepted-records',${JSON.stringify(evidence)}::jsonb) ON CONFLICT(source,resource) DO UPDATE SET body=EXCLUDED.body,fetched_at=now(),error=NULL`);
      await t.execute(sql`UPDATE protocol_envelopes e SET validation_status=CASE WHEN (r.body->>'accepted')::integer=1 THEN 'pool-accepted' ELSE 'pool-rejected' END,validation_evidence=${JSON.stringify(evidence)}::jsonb||jsonb_build_object('reason',r.body->'reason')
        FROM protocol_reference_records r WHERE r.source=${source} AND r.generation=${generation} AND r.kind='envelopes' AND e.network=${network} AND e.txid=r.body->>'txid' AND e.input_index=(r.body->>'vin')::integer AND e.block_height=r.block_height AND e.block_hash=r.body->>'block_hash' AND e.chain_status='confirmed'`);
      await t.execute(sql`DELETE FROM protocol_reference_records WHERE source=${source} AND generation<>${generation}`);
    });
  } catch(e) {
    await db.execute(sql`DELETE FROM protocol_reference_records WHERE source=${source} AND generation=${generation}`);
    throw e;
  }
}

// Import the upstream worker's transaction journal to a published sequence.
// Pages may commit independently; reads remain at the last published sequence.
export async function refreshCanonicalRecords(base:URL,network:string) {
  const status=await readJson(new URL('/tacitscan/status',base));
  if(status.network!==network||status.sourceRevision!==PROTOCOL_REVISION||status.error||typeof status.epoch!=='string'||!/^\d+$/.test(status.lastSeq??'')) throw new Error('Canonical replay unavailable');
  const source=`tacit:${network}`;
  const old=await db.execute<{body:Record<string,any>}>(sql`SELECT body FROM protocol_snapshots WHERE source=${source} AND resource='accepted-state'`);
  let after=old[0]?.body.epoch===status.epoch?String(old[0].body.lastSeq):'0';
  const target=BigInt(status.lastSeq);
  while(BigInt(after)<target) {
    const url=new URL('/tacitscan/changes',base);
    url.searchParams.set('epoch',status.epoch);url.searchParams.set('after',after);url.searchParams.set('at',status.lastSeq);
    const page=await readJson(url);
    if(page.epoch!==status.epoch||page.sourceRevision!==PROTOCOL_REVISION||!Array.isArray(page.rows)) throw new Error('Canonical epoch changed during import');
    let next=BigInt(after);
    await db.transaction(async t=>{
      for(const row of page.rows) {
        if(!/^\d+$/.test(row.seq)||BigInt(row.seq)<=next||BigInt(row.seq)>target) throw new Error('Invalid state sequence');
        next=BigInt(row.seq);
        await t.execute(sql`INSERT INTO protocol_state_changes(source,epoch,seq,kind,record_key,body,deleted)
          VALUES(${source},${status.epoch},${row.seq},${row.kind},${row.record_key},${JSON.stringify(row.body)}::jsonb,${row.deleted===true}) ON CONFLICT DO NOTHING`);
      }
    });
    if(next===BigInt(after)) throw new Error('State pagination stalled');
    after=next.toString();
  }
  const now=await readJson(new URL('/tacitscan/status',base));
  if(now.epoch!==status.epoch) throw new Error('State reorganized during import');
  await db.transaction(async t=>{
    await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${network}),81420)`);
    const canonical=await t.execute<{block_hash:string}>(sql`SELECT block_hash FROM blocks WHERE network=${network} AND height=${status.height}`);
    if(canonical[0]?.block_hash!==status.hash) throw new Error('Canonical state checkpoint differs from local chain');
    const evidence={...status,source:base.origin,provenance:'pinned-upstream-replay'};
    await t.execute(sql`INSERT INTO protocol_snapshots(source,resource,body) VALUES(${source},'accepted-state',${JSON.stringify(evidence)}::jsonb)
      ON CONFLICT(source,resource) DO UPDATE SET body=EXCLUDED.body,fetched_at=now(),error=NULL`);
    await t.execute(sql`DELETE FROM protocol_state_changes WHERE source=${source} AND epoch<>${status.epoch}`);
  });
}
