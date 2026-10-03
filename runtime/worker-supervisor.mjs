// All processes belong to the existing Render worker; adapter ports stay local.
import { spawn } from 'node:child_process';
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
  process.exitCode = code;
  for (const child of children) signalTree(child, signal);
  timer = setTimeout(() => {
    for (const child of children) signalTree(child, 'SIGKILL');
  }, 10000);
  if (!children.size) { clearTimeout(timer); process.exit(code); }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0, signal));
function launch(file, env = {}) {
  const child = spawn(process.execPath, ['--enable-source-maps', file], {
    stdio: 'inherit', detached: true, env: { ...process.env, ...env },
  });
  children.add(child);
  child.on('error', () => stop(1));
  child.on('exit', () => {
    children.delete(child);
    if (!stopping) stop(1);
    if (!children.size) { clearTimeout(timer); process.exit(process.exitCode ?? 1); }
  });
}
if (!process.env.DATABASE_URL || !process.env.BTC_POOL_CHECKPOINT) {
  throw new Error('DATABASE_URL and BTC_POOL_CHECKPOINT are required');
}
process.env.TACIT_REFERENCE_URL = 'http://127.0.0.1:8787';
process.env.BTC_POOL_REFERENCE_URL = 'http://127.0.0.1:8788';
launch('/app/state-service.mjs', { PORT: '8787', BIND_HOST: '127.0.0.1' });
launch('/app/pool-service.mjs', { PORT: '8788', BIND_HOST: '127.0.0.1' });
launch('/app/indexer/dist/rollout.js');
