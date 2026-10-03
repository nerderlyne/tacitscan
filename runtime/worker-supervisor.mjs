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
function launch(file, env = {}) {
  console.log(`[worker] starting ${file}`);
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
