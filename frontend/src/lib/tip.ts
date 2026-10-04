// Fetch current Bitcoin chain tip from mempool.space.
// Used by the sync indicator + /api/health to compute lag-from-tip.
// Soft fail (returns null) so a slow Esplora doesn't break page renders.
let lastTip: number | null = null;
let checkedAt = 0;
let lastSuccess = 0;
let pending: Promise<number | null> | undefined;
async function readChainTip(): Promise<number | null> {
  try {
    const r = await fetch("https://mempool.space/api/blocks/tip/height", {
      signal: AbortSignal.timeout(3000),
      headers: { "user-agent": "tacitscan-frontend/0.1" },
    });
    if (!r.ok) return null;
    const t = await r.text();
    const n = Number(t.trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// Remote Esplora must not hold the entire page render for three seconds.
// Refresh at most once per minute and share that request across visitors.
export async function fetchChainTip(): Promise<number | null> {
  const freshTip = () => Date.now() - lastSuccess < 300000 ? lastTip : null;
  if (Date.now() - checkedAt < 60000) return freshTip();
  if (!pending) pending = readChainTip().then(tip => {
    if (tip !== null) { lastTip = tip; lastSuccess = Date.now(); }
    checkedAt = Date.now(); pending = undefined; return freshTip();
  });
  if (freshTip() !== null) return freshTip();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 200); })]); }
  finally { clearTimeout(timer); }
}

// Bitcoin's expected ~10 min/block. Lag in blocks → human time.
export function lagToHuman(blocks: number): string {
  const min = blocks * 10;
  if (min < 60) return `~${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `~${hr}h`;
  const day = (min / 1440).toFixed(1);
  return `~${day}d`;
}
