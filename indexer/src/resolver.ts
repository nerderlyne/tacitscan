// Background loop that resolves each asset's image_uri to a final HTTPS
// image URL. Tacit assets often follow the NFT pattern where image_uri
// points to metadata JSON containing an `image` field, not the image
// itself. Persist successes and retry transient failures.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "./db.js";

import { fetchAssetMedia } from './asset-media.js';
const IDLE_POLL_MS = 30_000;
const BATCH_SIZE = 20;

async function processAsset(asset: { assetId: string; imageUri: string }): Promise<boolean> {
  try {
    const media = await fetchAssetMedia(asset.imageUri);
    if (!media.imageUrl) throw new Error("Metadata has no supported IPFS image");
    const resolved = media.imageUrl;
    await db
      .update(schema.assets)
      .set({
        resolvedImageUrl: resolved,
        imageResolvedAt: new Date(),
        imageResolveError: null,
      })
      .where(and(eq(schema.assets.assetId, asset.assetId), eq(schema.assets.imageUri, asset.imageUri)));
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(schema.assets)
      .set({
        imageResolvedAt: new Date(),
        imageResolveError: msg.slice(0, 500),
      })
      .where(and(eq(schema.assets.assetId, asset.assetId), eq(schema.assets.imageUri, asset.imageUri)));
    return false;
  }
}

export async function runResolver(): Promise<never> {
  console.log("[resolver] started");
  while (true) {
    const candidates = await db
      .select({ assetId: schema.assets.assetId, imageUri: schema.assets.imageUri })
      .from(schema.assets)
      .where(
        and(
          isNotNull(schema.assets.imageUri),
          sql`(${schema.assets.imageResolvedAt} IS NULL
            OR (${schema.assets.imageResolveError} IS NOT NULL AND ${schema.assets.imageResolvedAt}<now()-interval '1 hour')
            OR (${schema.assets.resolvedImageUrl} LIKE 'https://content.wrappr.wtf/ipfs/%' AND ${schema.assets.imageResolveError} IS NULL))`,
        ),
      )
      .limit(BATCH_SIZE);

    if (candidates.length === 0) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const startedAt = Date.now();
    let ok = 0;
    let fail = 0;
    // Process this batch with limited concurrency so we don't hammer
    // gateways. 4 in flight is gentle.
    const work = [...candidates];
    const concurrency = 4;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (work.length > 0) {
          const a = work.shift()!;
          if (!a.imageUri) continue;
          try {
            if (await processAsset(a as { assetId: string; imageUri: string })) ok++;
            else fail++;
          } catch {
            fail++;
          }
        }
      }),
    );
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[resolver] batch: +${ok} resolved, ${fail} failed in ${took}s`);
    await sleep(IDLE_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((res) => setTimeout(res, ms));
}
