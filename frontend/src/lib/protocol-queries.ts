import { sql } from 'drizzle-orm';
import { db } from '../db';
import { PROTOCOL_REVISION, DECODER_VERSION } from './protocol';
export const parityEnabled = () => (process.env.PARITY_UI_ENABLED ?? import.meta.env.PARITY_UI_ENABLED) === 'true';
export const bitcoinNetwork = import.meta.env.PUBLIC_NETWORK ?? 'mainnet';
export const chainName = (chain:string|number) => ({'1':'Ethereum','8453':'Base','4663':'Robinhood Chain',mainnet:'Bitcoin',signet:'Bitcoin signet'}[String(chain)] ?? String(chain));
export const sections = {activity:'All activity',assets:'Assets',pools:'AMM pools',farms:'Farms',bridge:'Bridge & reflection',collateral:'cBTC & CDPs','secret-sats':'Secret Sats',locks:'Notes & locks'};
const families:Record<string,string[]>= {pools:['amm'],farms:['farm'],bridge:['bridge','reflection'],collateral:['collateral'], 'secret-sats':['bitcoin-pool','evm-pool']};
export async function protocolRead<T>(read:()=>Promise<T>,fallback:T,allowPending=false):Promise<{data:T;error:string|null}> {
  if(!parityEnabled()) return {data:fallback,error:'Protocol indexing is not enabled yet.'};
  try {
    if (!allowPending && (process.env.PARITY_REQUIRE_READY ?? import.meta.env.PARITY_REQUIRE_READY) === 'true') {
      const [report] = await db.execute<{ready:boolean}>(sql`SELECT
        (error IS NULL AND fetched_at>now()-interval '3 minutes'
        AND body->>'ready'='true' AND body->>'sourceRevision'=${PROTOCOL_REVISION}
        AND body->>'decoderVersion'=${String(DECODER_VERSION)}) AS ready
        FROM protocol_snapshots WHERE source='tacitscan' AND resource='readiness'`);
      if (!report?.ready) return {data:fallback,error:'Protocol indexing is catching up or awaiting reconciliation. See Protocol Status for progress. Existing Bitcoin pages remain available.'};
    }
    return {data:await read(),error:null};
  }
  catch(e) {console.error('[protocol-read]',e instanceof Error?e.message:'read failed');return {data:fallback,error:'Protocol data is temporarily unavailable. Existing Bitcoin pages remain available.'};}
}
export async function protocolActivity(section='activity',chain='',query='',offset=0) {
  const q=query.trim().slice(0,128);const pattern='%'+q+'%';
  const fs=families[section]??[];
  return protocolRead(async()=>{
    const rows=await db.execute<Record<string,any>>(sql`
      SELECT * FROM (
        SELECT network AS chain,txid,input_index AS ordinal,opcode AS name,family,asset_id,
          block_height::bigint AS height,chain_status AS status,decode_status,validation_status AS validation,
          decoded AS details,(${q}<>'' AND carrier::text ILIKE ${pattern}) AS carrier_match FROM protocol_envelopes WHERE network=${bitcoinNetwork} AND chain_status IN ('confirmed','mempool')
        UNION ALL
        SELECT chain_id::text AS chain,txid,log_index AS ordinal,event_name AS name,family,address AS asset_id,
          block_height AS height,'confirmed' AS status,'decoded' AS decode_status,'on-chain event' AS validation,
          decoded AS details,false AS carrier_match FROM protocol_events
        UNION ALL
        SELECT chain_id::text,txid,call_index,'Settlement','confidential',deployment,block_height,'confirmed',CASE WHEN decode_error IS NULL THEN 'decoded' ELSE 'unsupported' END,authority,public_values,false FROM protocol_settlements
      ) a WHERE (${chain}='' OR a.chain=${chain})
        AND (${fs.length===0} OR family=ANY(ARRAY[${sql.join(fs.map(v=>sql`${v}`),sql`, `)}]::text[]))
        AND (${q}='' OR txid ILIKE ${pattern} OR asset_id ILIKE ${pattern} OR details::text ILIKE ${pattern} OR carrier_match)
      ORDER BY chain, height DESC NULLS FIRST,txid,ordinal LIMIT 100 OFFSET ${Math.max(0,Math.min(offset,100000))}`);
    return [...rows];
  },[] as Record<string,any>[]);
}
export async function protocolStatus() {
  return protocolRead(async()=>{
    const [cursors,snapshots]=await Promise.all([
      db.execute<Record<string,any>>(sql`SELECT * FROM protocol_cursors ORDER BY source`),
      db.execute<Record<string,any>>(sql`SELECT source,resource,body,fetched_at,error FROM protocol_snapshots ORDER BY source,resource`),
    ]);
    return {cursors:[...cursors],snapshots:[...snapshots]};
  },{cursors:[] as Record<string,any>[],snapshots:[] as Record<string,any>[]},true);
}
export async function protocolTransaction(chain:string,txid:string) {
  return protocolRead(async()=>{
    if(chain==='mainnet'||chain==='signet') {
      if(chain!==bitcoinNetwork) return [];
      return [...await db.execute<Record<string,any>>(sql`SELECT input_index AS ordinal,opcode AS name,block_height AS height,block_hash,chain_status AS status,decode_status,decode_error,validation_status AS validation,validation_evidence,support,decoded AS details,encode(raw_payload,'hex') AS raw,asset_id FROM protocol_envelopes WHERE network=${chain} AND txid=${txid} ORDER BY input_index`)];
    }
    if(!['1','8453','4663'].includes(chain)) return [];
    return [...await db.execute<Record<string,any>>(sql`SELECT log_index AS ordinal,event_name AS name,block_height AS height,block_hash,'confirmed' AS status,'decoded' AS decode_status,'on-chain event' AS validation,address AS asset_id,decoded AS details,raw_log AS raw FROM protocol_events WHERE chain_id=${Number(chain)} AND txid=${txid} ORDER BY log_index`)];
  },[] as Record<string,any>[]);
}
export async function protocolAssets() {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`SELECT * FROM (SELECT * FROM protocol_assets UNION ALL SELECT chain_id,address,decoded->>'assetId','canonical-factory',decoded->>'token',decoded->>'symbol','Tacit Token',(decoded->>'decimals')::integer,NULL::text,block_height,decoded FROM protocol_events WHERE event_name='Deployed') a ORDER BY chain_id,block_height DESC LIMIT 500`)],[] as Record<string,any>[]);
}
export async function protocolOutput(txid:string,vout:number) {
  return protocolRead(async()=>{
    const rows=await db.execute<Record<string,any>>(sql`SELECT o.*,s.spending_txid,j.evidence AS validation_evidence,j.checked_at,
      (SELECT jsonb_agg(jsonb_build_object('chain',v.chain_id,'deployment',v.address,'txid',v.txid,'height',v.block_height)) FROM protocol_events v
       WHERE v.event_name='BitcoinNotesConsumed' AND j.evidence->>'publicNoteNullifier' IS NOT NULL
         AND v.decoded @> jsonb_build_object('nullifiers',jsonb_build_array(j.evidence->'publicNoteNullifier'))) AS ethereum_consumption
      FROM protocol_outputs o
      LEFT JOIN protocol_validation_jobs j ON j.network=o.network AND j.txid=o.txid AND j.vout=o.vout
      LEFT JOIN protocol_spends s ON s.network=o.network AND s.source_txid=o.txid AND s.source_vout=o.vout
      WHERE o.network=${bitcoinNetwork} AND o.txid=${txid} AND o.vout=${vout}`);
    return rows[0]??null;
  },null as Record<string,any>|null);
}

export async function protocolSettlements(chain:string,txid:string) {
  return protocolRead(async()=>{
    if(!['1','8453','4663'].includes(chain)) return [];
    return [...await db.execute<Record<string,any>>(sql`SELECT * FROM protocol_settlements WHERE chain_id=${Number(chain)} AND txid=${txid} ORDER BY call_index`)];
  },[] as Record<string,any>[]);
}
export async function canonicalRecords(kind:string,query='',offset=0) {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (c.record_key) c.record_key,c.body,c.deleted,s.body AS checkpoint,s.fetched_at,s.error
      FROM protocol_state_changes c JOIN protocol_snapshots s ON s.source=c.source AND s.resource='accepted-state' AND s.body->>'epoch'=c.epoch
      JOIN blocks b ON b.network=${bitcoinNetwork} AND b.height=(s.body->>'height')::integer AND b.block_hash=s.body->>'hash'
      WHERE c.source=${'tacit:'+bitcoinNetwork} AND c.kind=${kind} AND c.seq<=(s.body->>'lastSeq')::bigint
      ORDER BY c.record_key,c.seq DESC
    ) latest WHERE NOT deleted AND (${query}='' OR record_key ILIKE ${'%'+query.slice(0,128)+'%'} OR body::text ILIKE ${'%'+query.slice(0,128)+'%'})
    ORDER BY record_key LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function acceptedPoolRecords(kind='notes',query='',offset=0) {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`
    SELECT r.kind,r.body,s.body AS checkpoint,s.fetched_at,s.error FROM protocol_reference_records r
    JOIN protocol_snapshots s ON r.source=s.source AND s.resource='accepted-records' AND s.body->>'generation'=r.generation
    JOIN blocks b ON b.network=${bitcoinNetwork} AND b.height=(s.body->>'height')::integer AND b.block_hash=s.body->>'blockHash'
    WHERE r.source=${'btc-pool:'+bitcoinNetwork} AND r.kind=${kind} AND (${query}='' OR r.body::text ILIKE ${'%'+query.slice(0,128)+'%'})
    ORDER BY r.block_height DESC,r.record_key LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function settlementEffects(section='activity',query='',offset=0) {
  const kinds:Record<string,string[]>={pools:['swaps','liquidity','publicAmm'],farms:['harvestActionIds'],collateral:['cdpMints','cdpCloses','cdpLiquidations','cdpTopups','cbtcMints'],bridge:['bitcoinBurnsConsumed','bitcoinBurnIdsConsumed','bitcoinConsumedSources','crossOuts'],locks:['lockLeaves','lockNullifiers','adaptorClaimS']};
  const filter=kinds[section]??[];
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`SELECT * FROM protocol_effects WHERE (${filter.length===0} OR kind=ANY(ARRAY[${sql.join(filter.map(v=>sql`${v}`),sql`, `)}]::text[])) AND (${query}='' OR txid ILIKE ${'%'+query.slice(0,128)+'%'} OR body::text ILIKE ${'%'+query.slice(0,128)+'%'}) ORDER BY chain_id,block_height DESC,txid,call_index,effect_index LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function bridgeProgress(query='',offset=0) {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`
    SELECT e.txid,e.opcode,e.block_height,e.asset_id,e.decoded,
      CASE WHEN e.opcode='T_POOL_BRIDGE_BURN' THEN (
        SELECT jsonb_agg(jsonb_build_object('chain',f.chain_id,'txid',f.txid,'height',f.block_height,'burnId',f.body)) FROM protocol_effects f
        WHERE f.kind='bitcoinBurnIdsConsumed' AND e.decoded->'bridgeBurnIds' @> jsonb_build_array(f.body)
      ) ELSE (
        SELECT jsonb_agg(jsonb_build_object('chain',v.chain_id,'txid',v.txid,'height',v.block_height,'claimId',v.decoded->'claimId')) FROM protocol_events v
        WHERE v.event_name='CrossOutRecorded' AND lower(v.decoded->>'claimId')='0x'||lower(e.decoded->>'claimId')
      ) END AS counterpart,
      EXISTS(SELECT 1 FROM protocol_validation_jobs j WHERE j.network=e.network AND j.txid=e.txid AND j.vout=0 AND j.status='accepted' AND j.block_hash=e.block_hash) AS bitcoin_output_accepted
    FROM protocol_envelopes e WHERE e.network=${bitcoinNetwork} AND e.chain_status='confirmed' AND e.opcode IN ('T_POOL_BRIDGE_BURN','T_CROSSOUT_MINT')
      AND (${query}='' OR e.txid ILIKE ${'%'+query.slice(0,128)+'%'} OR e.decoded::text ILIKE ${'%'+query.slice(0,128)+'%'})
    ORDER BY e.block_height DESC,e.tx_index DESC LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function publicSupply() {
  // Token-domain totals stay separate: wrapped, locked and bridged assets must
  // not be summed into an invented cross-chain circulating supply.
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`
    SELECT chain_id,address,
      COALESCE(sum((decoded->>'value')::numeric) FILTER(WHERE decoded->>'from'='0x0000000000000000000000000000000000000000'),0)::text AS minted,
      COALESCE(sum((decoded->>'value')::numeric) FILTER(WHERE decoded->>'to'='0x0000000000000000000000000000000000000000'),0)::text AS burned,
      (COALESCE(sum((decoded->>'value')::numeric) FILTER(WHERE decoded->>'from'='0x0000000000000000000000000000000000000000'),0)-COALESCE(sum((decoded->>'value')::numeric) FILTER(WHERE decoded->>'to'='0x0000000000000000000000000000000000000000'),0))::text AS net_issued,
      max(block_height)::text AS last_token_event_height
    FROM protocol_events WHERE event_name='Transfer' GROUP BY chain_id,address ORDER BY chain_id,address`)],[] as Record<string,any>[]);
}

export async function noteEntries(query='',offset=0,tree='') {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`SELECT * FROM protocol_note_entries WHERE (${tree}='' OR tree=${tree}) AND (${query}='' OR leaf::text ILIKE ${'%'+query.slice(0,128)+'%'} OR txid ILIKE ${'%'+query.slice(0,128)+'%'}) ORDER BY chain_id,block_height DESC,leaf_index DESC LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function nullifierEntries(query='',offset=0) {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`SELECT * FROM protocol_nullifier_entries WHERE (${query}='' OR nullifier::text ILIKE ${'%'+query.slice(0,128)+'%'} OR txid ILIKE ${'%'+query.slice(0,128)+'%'}) ORDER BY chain_id,block_height DESC LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}

export async function protocolReadiness() {
  return protocolRead(async()=>{
    const rows=await db.execute<Record<string,any>>(sql`SELECT body,fetched_at,error,fetched_at>now()-interval '3 minutes' AS fresh FROM protocol_snapshots WHERE source='tacitscan' AND resource='readiness'`);
    const row=rows[0];
    const matches=row?.body.sourceRevision===PROTOCOL_REVISION && row?.body.decoderVersion===DECODER_VERSION;
    return {ready:!!row?.fresh&&!row.error&&row.body.ready===true&&matches,checks:(row?.body.checks??[]) as {name:string;ready:boolean;detail:string}[],checkedAt:row?.body.checkedAt??null,reason:!row?'No readiness report published':!matches?'Readiness report belongs to another protocol revision':!row.fresh?'Readiness report is stale':row.error??null};
  },{ready:false,checks:[] as {name:string;ready:boolean;detail:string}[],checkedAt:null,reason:'Readiness unavailable'},true);
}
export async function virtualAssets(query='',offset=0) {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (c.record_key) c.body,c.deleted,s.body AS checkpoint,c.record_key
      FROM protocol_state_changes c JOIN protocol_snapshots s ON s.source=c.source AND s.resource='accepted-state' AND s.body->>'epoch'=c.epoch
      JOIN blocks b ON b.network=${bitcoinNetwork} AND b.height=(s.body->>'height')::integer AND b.block_hash=s.body->>'hash'
      WHERE c.source=${'tacit:'+bitcoinNetwork} AND c.kind='pools' AND c.seq<=(s.body->>'lastSeq')::bigint ORDER BY c.record_key,c.seq DESC
    ) SELECT body->>'lp_asset_id' AS asset_id,'bitcoin-lp' AS origin,body,checkpoint FROM latest
      WHERE NOT deleted AND body ? 'lp_asset_id' AND (${query}='' OR body::text ILIKE ${'%'+query.slice(0,128)+'%'}) ORDER BY record_key LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function collateralProgress(query='',offset=0) {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`
    SELECT e.txid,e.opcode,e.decoded,e.block_height,
      (SELECT jsonb_agg(jsonb_build_object('chain',v.chain_id,'txid',v.txid,'event',v.event_name,'details',v.decoded) ORDER BY v.block_height,v.log_index)
       FROM protocol_events v WHERE v.decoded->>'outpoint'=e.decoded->>'outpoint') AS escrow_events,
      (SELECT jsonb_agg(jsonb_build_object('chain',f.chain_id,'txid',f.txid,'kind',f.kind,'details',f.body) ORDER BY f.block_height)
       FROM protocol_effects f WHERE f.kind='cbtcMints' AND f.body->>'outpoint'=e.decoded->>'outpoint') AS accepted_mints,
      (SELECT jsonb_agg(jsonb_build_object('txid',r.txid,'operation',r.opcode,'height',r.block_height)) FROM protocol_envelopes r
       WHERE r.network=e.network AND r.chain_status='confirmed' AND r.opcode='T_CBTC_REDEEM' AND r.decoded->>'outpoint'=e.decoded->>'outpoint') AS redemptions
    FROM protocol_envelopes e WHERE e.network=${bitcoinNetwork} AND e.chain_status='confirmed' AND e.opcode='T_CBTC_LOCK'
      AND (${query}='' OR e.txid ILIKE ${'%'+query.slice(0,128)+'%'} OR e.decoded::text ILIKE ${'%'+query.slice(0,128)+'%'})
    ORDER BY e.block_height DESC,e.tx_index DESC LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function callProgress(query='',offset=0) {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`
    SELECT e.txid,e.opcode,e.decoded,e.block_height,
      (SELECT jsonb_agg(jsonb_build_object('chain',v.chain_id,'txid',v.txid,'event',v.event_name,'details',v.decoded)) FROM protocol_events v
       WHERE (e.opcode='T_BTC_CALL' AND v.event_name='BtcCallExecuted' AND v.decoded->>'callId'=e.decoded->>'callId'
          AND lower(v.address)='0x'||lower(e.decoded->>'executor') AND lower(v.decoded->>'target')='0x'||lower(e.decoded->>'target') AND lower(v.decoded->>'callerPubkey')='0x'||lower(e.decoded->>'callerPubkey'))
         OR (e.opcode='T_ETH_CALL' AND v.event_name='EthMessageSent' AND lower(v.decoded->>'msgId')='0x'||lower(e.decoded->>'messageId')
          AND lower(v.decoded->>'ns')='0x'||lower(e.decoded->>'namespace') AND lower(v.decoded->>'sender')='0x'||lower(e.decoded->>'sender') AND v.decoded->>'destChain'=e.decoded->>'destChain')) AS counterpart
    FROM protocol_envelopes e WHERE e.network=${bitcoinNetwork} AND e.chain_status='confirmed' AND e.opcode IN ('T_BTC_CALL','T_ETH_CALL')
      AND (${query}='' OR e.txid ILIKE ${'%'+query.slice(0,128)+'%'} OR e.decoded::text ILIKE ${'%'+query.slice(0,128)+'%'})
    ORDER BY e.block_height DESC,e.tx_index DESC LIMIT 100 OFFSET ${offset}`)],[] as Record<string,any>[]);
}
export async function evmVirtualAssets(query='') {
  return protocolRead(async()=>[...await db.execute<Record<string,any>>(sql`SELECT s.source,s.body->>'height' AS height,s.body->>'blockHash' AS block_hash,p.key AS pool_id,p.value AS body,s.fetched_at,s.error
    FROM protocol_snapshots s CROSS JOIN LATERAL jsonb_each(s.body->'pools') p
    WHERE s.resource='state' AND s.source LIKE 'evm:%' AND (${query}='' OR p.value::text ILIKE ${'%'+query.slice(0,128)+'%'} OR p.key ILIKE ${'%'+query.slice(0,128)+'%'}) ORDER BY s.source,p.key`)],[] as Record<string,any>[]);
}
