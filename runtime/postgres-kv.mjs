import { AsyncLocalStorage } from 'node:async_hooks';
// Same KV contract as Tacit's Node driver, with request-scoped transactions.
export async function createTransactionalDriver(pg,url) {
  const pool=new pg.Pool({connectionString:url,max:6,options:"-c search_path=tacitscan_canonical"});
  await pool.query('CREATE SCHEMA IF NOT EXISTS tacitscan_canonical');
  pool.on('error',e=>console.error('[state-db]',e.code));
  await pool.query('CREATE TABLE IF NOT EXISTS kv(ns text NOT NULL,k text COLLATE "C" NOT NULL,v bytea NOT NULL,metadata jsonb,expires_at timestamptz,PRIMARY KEY(ns,k))');
  await pool.query('CREATE TABLE IF NOT EXISTS upstream_changes(seq bigserial PRIMARY KEY,epoch text NOT NULL,kind text NOT NULL,record_key text NOT NULL,body jsonb,deleted boolean NOT NULL DEFAULT false)');
  await pool.query('CREATE INDEX IF NOT EXISTS upstream_changes_epoch_seq ON upstream_changes(epoch,seq)');
  const context=new AsyncLocalStorage();
  const reading=new AsyncLocalStorage();
  const query=(text,values)=> (context.getStore()??pool).query(text,values);
  const output=r=>({value:r.v,metadata:r.metadata,expiresAt:r.expires_at?new Date(r.expires_at).getTime():null});
  async function journal(ns,key,value,deleted=false) {
    if(!context.getStore()||!ns.endsWith(':REGISTRY_KV')) return;
    const kind=({asset:'assets',petch:'assets',mint:'mints',burn:'burns',ammpool:'pools',ammfarm:'farms',ammfarmbond:'bonds',ammop:'operations',pmint:'public-mints','crossout-recorded':'crossouts','crossout-minted':'crossout-mints',petch_progress:'mint-progress'})[key.split(':')[0]];
    if(!kind) return;
    let body=null;
    if(!deleted) try {body=JSON.parse(Buffer.from(value).toString());} catch {body=Buffer.from(value).toString();}
    await query('INSERT INTO upstream_changes(epoch,kind,record_key,body,deleted) VALUES($1,$2,$3,$4,$5)',[ns.split(':')[0],kind,key,JSON.stringify(body),deleted]);
  }
  const driver={
    async get(ns,k) {const {rows}=await query('SELECT * FROM kv WHERE ns=$1 AND k=$2 AND (expires_at IS NULL OR expires_at>now())',[ns,k]);return rows[0]?output(rows[0]):null;},
    async put(ns,k,value,{metadata=null,expiresAt=null}={}) {if(reading.getStore()) return;await query('INSERT INTO kv(ns,k,v,metadata,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(ns,k) DO UPDATE SET v=EXCLUDED.v,metadata=EXCLUDED.metadata,expires_at=EXCLUDED.expires_at',[ns,k,value,metadata,expiresAt===null?null:new Date(expiresAt)]);await journal(ns,k,value);},
    async putMany(rows) {for(const r of rows) await driver.put(r.ns,r.key,r.value,r);return rows.length;},
    async delete(ns,k) {if(reading.getStore()) return false;const result=await query('DELETE FROM kv WHERE ns=$1 AND k=$2',[ns,k]);await journal(ns,k,null,true);return result.rowCount>0;},
    async list(ns,{prefix='',limit=1000,after=null}={}) {
      const {rows}=await query('SELECT k,metadata,expires_at FROM kv WHERE ns=$1 AND starts_with(k,$2) AND ($3::text IS NULL OR k>$3) AND (expires_at IS NULL OR expires_at>now()) ORDER BY k LIMIT $4',[ns,prefix,after,limit+1]);
      return {complete:rows.length<=limit,entries:rows.slice(0,limit).map(r=>({name:r.k,metadata:r.metadata,expiresAt:r.expires_at?new Date(r.expires_at).getTime():null}))};
    },
    async count(ns,{prefix=''}={}) {return Number((await query('SELECT count(*) AS n FROM kv WHERE ns=$1 AND starts_with(k,$2) AND (expires_at IS NULL OR expires_at>now())',[ns,prefix])).rows[0].n);},
    readOnly:fn=>reading.run(true,fn),
    async transaction(fn) {
      if(context.getStore()) return fn();
      const connection=await pool.connect();
      try {await connection.query('BEGIN');await connection.query('SELECT pg_advisory_xact_lock(81425)');const result=await context.run(connection,fn);await connection.query('COMMIT');return result;}
      catch(e) {await connection.query('ROLLBACK');throw e;} finally {connection.release();}
    },
    async lastSequence(epoch) {return (await query('SELECT COALESCE(max(seq),0)::text AS seq FROM upstream_changes WHERE epoch=$1',[epoch])).rows[0].seq;},
    async changes(epoch,after,at) {return (await query('SELECT seq::text,kind,record_key,body,deleted FROM upstream_changes WHERE epoch=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT 1000',[epoch,after,at])).rows;},
    async claimLease(name) {
      const lease=await pool.connect();
      const locked=(await lease.query('SELECT pg_try_advisory_lock(hashtext($1),81426) AS locked',[name])).rows[0].locked;
      if(!locked) {lease.release();throw new Error('Another canonical state worker holds the lease');}
    },
    close:()=>pool.end(),
  };
  return driver;
}
