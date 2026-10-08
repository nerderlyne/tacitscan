// All processes belong to the existing Render worker; adapter ports stay local.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const children = new Set();
let stopping = false;
let timer;
function signalTree(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function stop(code, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  console.error(`[worker] stopping all processes (exit=${code}, signal=${signal})`);
  process.exitCode = code;
  for (const child of children) signalTree(child, signal);
  timer = setTimeout(() => {
    for (const child of children) signalTree(child, 'SIGKILL');
  }, 10000);
  if (!children.size) { clearTimeout(timer); process.exit(code); }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0, signal));
// The two local reference services are sidecars: when one exits (the state service exits 75 to be started afresh after a
// failed replay step), only it is started again, after a backoff that grows while it keeps failing, and the indexer runs on.
// Taking the whole container down for it turns one unreachable source into a crash loop that Render suspends.
const SIDECARS = new Set(['/app/state-service.mjs', '/app/pool-service.mjs']);
const restarts = new Map();
function launch(file, env = {}) {
  console.log(`[worker] starting ${file}`);
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['--enable-source-maps', file], {
    stdio: 'inherit', detached: true, env: { ...process.env, ...env },
  });
  children.add(child);
  child.on('error', error => {
    console.error(`[worker] could not start ${file}: ${error.code ?? 'spawn failed'}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    console.error(`[worker] ${file} exited (code=${code}, signal=${signal ?? 'none'})`);
    children.delete(child);
    if (!stopping && SIDECARS.has(file)) {
      // A run of ten minutes or more counts as healthy, so the next failure starts the backoff over.
      const n = Date.now() - startedAt >= 600000 ? 1 : (restarts.get(file) ?? 0) + 1;
      restarts.set(file, n);
      const delay = Math.min(300000, 10000 * 2 ** (n - 1));
      console.error(`[worker] starting ${file} again in ${delay / 1000}s (attempt ${n}); the indexer keeps running`);
      setTimeout(() => { if (!stopping) launch(file, env); }, delay);
      return;
    }
    if (!stopping) stop(1);
    if (!children.size) { clearTimeout(timer); process.exit(process.exitCode ?? 1); }
  });
}
console.log(`[worker] supervisor started (Node ${process.versions.node})`);
for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
  try { if (existsSync(path)) { console.log(`[worker] container memory limit: ${readFileSync(path, 'utf8').trim()}`); break; } }
  catch { /* Memory reporting is diagnostic only. */ }
}
const required = ['DATABASE_URL', 'BTC_POOL_CHECKPOINT'];
for (const [alias, original] of [['RPC_ETH', 'EVM_RPC_URL_1'], ['RPC_BASE', 'EVM_RPC_URL_8453'], ['RPC_ROBINHOOD', 'EVM_RPC_URL_4663']]) {
  if (!process.env[alias] && !process.env[original]) required.push(alias);
}
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`[worker] missing required configuration: ${missing.join(', ')}. Link tacitscan-parity-secrets to tacitscan-indexer.`);
  process.exit(1);
}
process.env.TACIT_REFERENCE_URL = 'http://127.0.0.1:8787';
process.env.BTC_POOL_REFERENCE_URL = 'http://127.0.0.1:8788';
launch('/app/state-service.mjs', { PORT: '8787', BIND_HOST: '127.0.0.1' });
launch('/app/pool-service.mjs', { PORT: '8788', BIND_HOST: '127.0.0.1' });
launch('/app/indexer/dist/rollout.js');
