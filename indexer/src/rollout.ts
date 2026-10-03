// Render starts this only after stopping the previous writer (persistent disk).
// Keep migrations and historical repair out of the frontend deployment path.
import './rpc-config.js';
import { spawn, type ChildProcess } from 'node:child_process';
import postgres from 'postgres';
import { PROTOCOL_REVISION, DECODER_VERSION } from './protocol.js';

for (const name of ['TACIT_REFERENCE', 'BTC_POOL_REFERENCE']) {
  if (!process.env[`${name}_URL`] && process.env[`${name}_HOSTPORT`]) {
    process.env[`${name}_URL`] = `http://${process.env[`${name}_HOSTPORT`]}`;
  }
}
let child: ChildProcess | undefined;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  stopping = true;
  if (child) child.kill(signal);
  else process.exit(0);
});
async function run(file: string, args: string[] = []) {
  if (stopping) throw new Error('Deployment stopping');
  await new Promise<void>((resolve, reject) => {
    child = spawn(process.execPath, ['--enable-source-maps', new URL(file, import.meta.url).pathname, ...args], {
      stdio: 'inherit', env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${file} stopped (${signal ?? code})`));
    });
  });
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (process.env.AUTO_PROTOCOL_REPLAY === 'true') {
    for (const name of ['EVM_RPC_URL_1', 'EVM_RPC_URL_8453', 'EVM_RPC_URL_4663', 'TACIT_REFERENCE_URL', 'BTC_POOL_REFERENCE_URL']) {
      if (!process.env[name]) throw new Error(`Missing deployment configuration: ${name}`);
    }
    if (process.env.PARITY_INDEXING_ENABLED !== 'true') throw new Error('Automatic replay requires PARITY_INDEXING_ENABLED');
  }
  // Dedicated connection holds a lease for the entire child process lifetime.
  const connection = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 0, max_lifetime: 0, prepare: false });
  const lease = await connection.reserve();
  const network = process.env.BITCOIN_NETWORK || 'mainnet';
  const [lock] = await lease`SELECT pg_try_advisory_lock(hashtext(${network}),81429) AS locked, pg_backend_pid() AS pid`;
  if (!lock?.locked) throw new Error('Another deployment holds the indexer writer lease');
  // Fail closed if the lease session disappears; never reconnect and keep writing.
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const [session] = await lease`SELECT pg_backend_pid() AS pid`;
      if (session?.pid !== lock.pid) throw new Error('Writer lease session changed');
    }
    catch { stopping = true; child?.kill('SIGTERM'); process.exitCode = 1; }
    finally { heartbeatBusy = false; }
  }, 5000);
  try {
    await run('migrate.js');
    if (process.env.AUTO_PROTOCOL_REPLAY === 'true') {
      const from = Number(process.env.START_HEIGHT || 948241);
      if (!Number.isSafeInteger(from) || from < 0) throw new Error('Invalid START_HEIGHT');
      const key = `bootstrap:${network}:${PROTOCOL_REVISION}:v${DECODER_VERSION}:${from}`;
      // Freeze the initial repair boundary so restarts resume the same range,
      // even after the ordinary indexer has subsequently advanced its cursor.
      await lease`INSERT INTO protocol_cursors(source,height,block_hash)
        SELECT ${key},last_indexed_height,last_indexed_block_hash FROM cursor WHERE network=${network}
        ON CONFLICT(source) DO NOTHING`;
      const [target] = await lease`SELECT height FROM protocol_cursors WHERE source=${key}`;
      if (target && Number(target.height) >= from) {
        await run('replay.js', ['--from', String(from), '--to', String(target.height), '--apply']);
      }
    }
    await run('index.js');
  } finally {
    clearInterval(heartbeat);
    await lease`SELECT pg_advisory_unlock(hashtext(${network}),81429)`;
    lease.release();
    await connection.end();
  }
}
main().catch(error => { console.error('[rollout]', error.message); process.exit(1); });
