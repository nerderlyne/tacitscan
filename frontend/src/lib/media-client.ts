import type { MediaResult } from './asset-media';
const pending = new Map<string, Promise<MediaResult>>();
export function loadAssetMedia(id: string): Promise<MediaResult> {
  const old = pending.get(id); if (old) return old;
  const value = fetch(`/api/asset-metadata?asset=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) })
    .then(async r => { if (!r.ok) throw new Error('Media unavailable'); return await r.json() as MediaResult; });
  pending.set(id, value);
  if (pending.size > 256) pending.delete(pending.keys().next().value!);
  value.catch(() => { if (pending.get(id) === value) pending.delete(id); });
  return value;
}
