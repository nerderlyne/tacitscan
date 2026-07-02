import type { APIRoute } from "astro";

export const prerender = false;

// Liveness probe for the platform (Render) health check. Returns 200 as
// long as the Node server is accepting requests — deliberately does NOT
// touch the DB or any external service. Coupling deploy success to those
// would fail an otherwise-healthy web service whenever the indexer lags
// or Postgres blips. Use /api/health for indexer freshness monitoring.
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ live: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
