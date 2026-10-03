// Explicit, bounded repair. Run with the normal Bitcoin worker stopped.
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { buildSource,loadConfig,processBlock } from './indexer.js';
import { DECODER_VERSION } from './protocol.js';
async function main() {
  const args=process.argv.slice(2);
  const read=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
  const cfg=loadConfig();
  const from=Number(read('--from')??cfg.startHeight);
  const to=Number(read('--to'));
  if(!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(to)||to<from) throw new Error('Usage: pnpm replay --from HEIGHT --to HEIGHT [--apply]');
  if(!args.includes('--apply')) {console.log(`Plan: replay ${cfg.network} blocks ${from}..${to}, decoder ${DECODER_VERSION}. No writes. Stop the Bitcoin worker before adding --apply.`);return;}
  if(process.env.PARITY_INDEXING_ENABLED!=='true') throw new Error('Enable PARITY_INDEXING_ENABLED before repair.');
  const cursor=await db.execute<{height:number}>(sql`SELECT last_indexed_height AS height FROM cursor WHERE network=${cfg.network}`);
  if(!cursor[0]||to>cursor[0].height) throw new Error('Replay must be bounded by the existing Bitcoin cursor.');
  const source=buildSource(cfg);
  const key=`bitcoin-replay:${cfg.network}:v${DECODER_VERSION}:${from}:${to}`;
  const prior=await db.execute<{height:string;block_hash:string}>(sql`SELECT height,block_hash FROM protocol_cursors WHERE source=${key}`);
  let next=prior[0]?Number(prior[0].height)+1:from;
  let hash=prior[0]?.block_hash??(next>0?await source.getBlockHashByHeight(next-1):'');
  if(prior[0] && await source.getBlockHashByHeight(next-1)!==hash) throw new Error('Replay checkpoint was reorganized; resume the regular worker to rewind before a fresh replay range.');
  for(;next<=to;next++) {
    const result=await processBlock(source,cfg.network,next,hash,false);
    if(result.reorg) throw new Error(`Chain changed at ${next}; replay stopped.`);
    hash=result.blockHash;
    // A crash before this checkpoint repeats an idempotent block; never skips it.
    await db.execute(sql`INSERT INTO protocol_cursors(source,height,block_hash) VALUES(${key},${next},${hash}) ON CONFLICT(source) DO UPDATE SET height=EXCLUDED.height,block_hash=EXCLUDED.block_hash,updated_at=now(),error=NULL`);
    if(next%100===0||next===to) console.log(`${key}: ${next}/${to}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1);});
