// Caching proxy for the tacit-pin worker's queue endpoint.
//
// The worker takes ~25-30s to return 700+ claims and scales linearly
// with queue size. If every page viewer fetched directly, the worker
// would melt under any real traffic. This endpoint sits in front:
// browsers hit /api/airdrop-queue.json (served from Render's CDN /
// downstream caches in <100ms), and we only call the worker once every
// ~30s regardless of viewer count.
//
// Cache behavior (CDN + downstream caches, via Cache-Control):
//   - s-maxage=30:                  fresh for 30s (only one viewer
//                                   triggers a worker re-fetch per 30s)
//   - stale-while-revalidate=3600:  serve stale for up to 1 hour while
//                                   refreshing in background
//
// So burst traffic (e.g. 1000 viewers in one minute) generates at most
// 1 worker call. If the worker is fully down for an hour, viewers see
// the last good snapshot instead of an error.
import type { APIRoute } from "astro";

export const prerender = false;
// Runs on Render as a long-lived Node service, so there is no per-request
// serverless timeout to worry about — the fetch below caps itself instead.

const DROP_ROOT = "3c578c51bbf33f583eee9e571514616775b8d9ae4e1b282e1fb9c4b5b268c545";
const WORKER_BASE = "https://tacit-pin.rosscampbell9.workers.dev";

export const GET: APIRoute = async ({ url }) => {
  const network = url.searchParams.get("network") || "mainnet";
  const workerUrl = `${WORKER_BASE}/airdrops/${DROP_ROOT}/claims?network=${encodeURIComponent(network)}`;

  try {
    // Cap the upstream fetch at 110s so we surface a useful error rather
    // than hang the request indefinitely if the worker stalls.
    const resp = await fetch(workerUrl, {
      signal: AbortSignal.timeout(110_000),
    });
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `worker ${resp.status}`, claims: [] }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          // Cache failures briefly + keep last good response stale-served
          // for up to an hour, so a transient blip doesn't blank the
          // page and doesn't pile load onto an already-struggling worker.
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=3600",
        },
      });
    }
    const body = await resp.text();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=3600",
        "X-Generated-At": new Date().toISOString(),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message?.slice(0, 200) ?? "fetch failed", claims: [] }), {
      status: 504,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=3600",
      },
    });
  }
};
