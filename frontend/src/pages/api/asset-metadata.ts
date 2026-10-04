import type { APIRoute } from 'astro';
import { getAsset } from '../../lib/queries';
import { cached } from '../../lib/cache';
import { fetchAssetMedia, normalizeMediaUri, ipfsPath } from '../../lib/asset-media';
export const prerender = false;
export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('asset') ?? '';
  if (!/^[a-f0-9]{64}$/.test(id)) return Response.json({ error: 'Invalid asset' }, { status: 400 });
  try {
    const data = await cached(`media:${id}`, 3600000, async () => {
      const asset = await getAsset(id);
      if (!asset) throw new Error('Asset unavailable');
      if (!asset.imageUri || !ipfsPath(asset.imageUri)) return {
        imageUrl: normalizeMediaUri(asset.resolvedImageUrl ?? asset.imageUri), metadata: null, sourceUrl: null,
      };
      return fetchAssetMedia(asset.imageUri);
    });
    return Response.json(data, { headers: { 'cache-control': 'public, max-age=300, s-maxage=300' } });
  } catch {
    return Response.json({ error: 'Asset media is temporarily unavailable. Please retry.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
};
