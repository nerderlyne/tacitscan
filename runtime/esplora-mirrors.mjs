// Reads of one Esplora-compatible Bitcoin API shared across several hosts that serve the same data.
//
// A replay from the start height downloads every block since then (about 1.7 MB each), tens of gigabytes in all, so one public
// host sees this address as abusive and answers 429 for long stretches. Each host is therefore paced (a small gap between
// requests), skipped for a while after it refuses or fails (the longer it keeps failing, the longer; a Retry-After is honoured),
// and the load is rotated across the hosts that are available. When every host is cooling the call waits for the soonest one, up
// to a limit, rather than failing: a replay that is merely slow should stay slow, not restart.
//
//   makeMirrors({ urls, fetchImpl, gapMs, now, sleep, maxWaitMs }) → { fetchBitcoin, askOne, status, hosts }
//   fetchBitcoin(url, init): `url` begins with one of `urls`; answered by whichever host will, as a Response.
//   askOne(base, path, init): one host only (a cross-check wants each host's own answer) → Response, or null while it is
//   cooling or when it failed; status() says why for each host.

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url); } };
const DEFAULT_SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeMirrors({ urls, fetchImpl = globalThis.fetch, gapMs = 120, now = () => Date.now(), sleep = DEFAULT_SLEEP, maxWaitMs = 15000 }) {
  const bases = [...new Set(urls.map((u) => String(u).trim().replace(/\/$/, '')).filter(Boolean))];
  if (!bases.length) throw new Error('makeMirrors: at least one URL is required');
  const st = new Map(bases.map((b) => [b, { until: 0, fails: 0, next: 0, why: null, ok: 0, refused: 0 }]));
  let turn = 0;
  const named = async (url, init) => {
    try { return await fetchImpl(url, init); }
    catch (e) { throw Object.assign(new Error(`${e?.message || e} (${hostOf(url)}${e?.cause?.code ? ` ${e.cause.code}` : ''})`), { cause: e?.cause ?? e }); }
  };
  const cool = (base, ms, why) => { const s = st.get(base); s.until = now() + ms; s.why = why; };

  async function askOne(base, path, init) {
    const s = st.get(base);
    if (!s || s.until > now()) return null;
    const wait = s.next - now();
    s.next = Math.max(s.next, now()) + gapMs;
    if (wait > 0) await sleep(wait);
    try {
      const r = await named(base + path, init);
      if (r.status === 429 || r.status >= 500) {
        s.fails++; s.refused++;
        const ra = Number(r.headers?.get?.('retry-after'));
        cool(base, Math.min(300000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15000 * 2 ** Math.min(s.fails - 1, 4)), `HTTP ${r.status}`);
        return null;
      }
      s.fails = 0; s.ok++; s.why = null;
      return r;
    } catch (e) {
      s.fails++; s.refused++;
      cool(base, Math.min(120000, 5000 * 2 ** Math.min(s.fails - 1, 4)), String(e?.message || e).slice(0, 120));
      return null;
    }
  }

  async function fetchBitcoin(url, init) {
    const first = bases.find((b) => url.startsWith(b));
    if (!first) throw new Error(`makeMirrors: ${url} is not under any configured host`);
    const path = url.slice(first.length), deadline = now() + maxWaitMs;
    for (;;) {
      const at = turn++ % bases.length, order = [...bases.slice(at), ...bases.slice(0, at)];
      for (const b of order) {
        const r = await askOne(b, path, init);
        if (r) return r;
      }
      const soonest = Math.min(...bases.map((b) => st.get(b).until));
      if (soonest >= deadline || now() >= deadline) throw new Error(`no Bitcoin source answered (${describe()})`);
      await sleep(Math.max(50, soonest - now()));
    }
  }

  const describe = () => bases.map((b) => { const s = st.get(b); return `${hostOf(b)}: ${s.until > now() ? `cooling ${Math.ceil((s.until - now()) / 1000)}s (${s.why})` : s.why ? `retrying after ${s.why}` : 'ok'}`; }).join('; ');
  const status = () => bases.map((b) => { const s = st.get(b); return { host: hostOf(b), ok: s.ok, refused: s.refused, coolingMs: Math.max(0, s.until - now()), why: s.why }; });
  return { fetchBitcoin, askOne, status, describe, bases };
}
