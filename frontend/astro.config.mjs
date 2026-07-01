import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  // Render runs this as a long-lived Node web service, so the standalone
  // adapter bundles its own HTTP server (dist/server/entry.mjs). It binds
  // to HOST/PORT from the environment — Render sets PORT for us.
  //
  // Note on caching: the edge ISR we had on Vercel is gone here. Per-route
  // freshness is instead handled by the cache-control headers the API
  // routes set themselves (feed/search: short max-age; health: no-store),
  // which Render's CDN and downstream caches honor.
  adapter: node({ mode: "standalone" }),
  server: {
    host: true,
    port: 4321,
  },
});
