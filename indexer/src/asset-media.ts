// Tacit uses IPFS, with Filebase as the pin mirror. Never fetch arbitrary
// issuer-selected hosts from the server, or persist a failed gateway as success.
export const MEDIA_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];
export function ipfsPath(uri: string | null | undefined): string | null {
  let value = uri?.trim() ?? '';
  if (value.startsWith('ipfs://')) value = value.slice(7).replace(/^ipfs\//, '');
  else if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const allowed = ['content.wrappr.wtf', 'ipfs.filebase.io', 'ipfs.io', 'w3s.link', 'dweb.link', 'gateway.pinata.cloud'];
      if (!allowed.includes(url.hostname) || !url.pathname.startsWith('/ipfs/')) return null;
      value = url.pathname.slice(6);
    } catch { return null; }
  }
  const [cid, ...segments] = value.split('/');
  if (!cid || !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})$/.test(cid)) return null;
  try {
    if (segments.some(p => { const v = decodeURIComponent(p); return !v || v === '.' || v === '..' || /[\\/?#\x00-\x1f]/.test(v); })) return null;
  } catch { return null; }
  return value;
}
export function normalizeMediaUri(uri: string | null | undefined): string | null {
  const path = ipfsPath(uri);
  if (path) return MEDIA_GATEWAYS[0] + path;
  try {
    const url = new URL(uri?.trim() ?? '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export type MediaResult = { imageUrl: string | null; metadata: Record<string, unknown> | null; sourceUrl: string };
async function limitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty metadata');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 65536) throw new Error('Metadata exceeds 64 KiB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export async function fetchAssetMedia(uri: string, fetcher: typeof fetch = fetch): Promise<MediaResult> {
  const path = ipfsPath(uri);
  if (!path) throw new Error('Server metadata lookup requires an IPFS URI');
  const controllers = MEDIA_GATEWAYS.map(() => new AbortController());
  const timer = setTimeout(() => controllers.forEach(c => c.abort()), 5000);
  try {
    return await Promise.any(MEDIA_GATEWAYS.map(async (gateway, i) => {
      const sourceUrl = gateway + path;
      const response = await fetcher(sourceUrl, { signal: controllers[i]!.signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Gateway unavailable'); }
      if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) {
        await response.body?.cancel(); return { imageUrl: sourceUrl, metadata: null, sourceUrl };
      }
      const metadata: unknown = JSON.parse(await limitedText(response));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid metadata');
      const fields = metadata as Record<string, unknown>;
      const inner = typeof fields.image === 'string' ? ipfsPath(fields.image) : null;
      return { imageUrl: inner ? gateway + inner : null, metadata: fields, sourceUrl };
    }));
  } catch { throw new Error('IPFS metadata unavailable; retry later'); }
  finally { clearTimeout(timer); controllers.forEach(c => c.abort()); }
}
