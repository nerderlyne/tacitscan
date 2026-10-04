// Bounded process-local cache with single-flight loads; errors are never cached.
const entries = new Map<string, { expires: number; value: Promise<unknown> }>();
export function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const old = entries.get(key);
  if (old && old.expires > Date.now()) return old.value as Promise<T>;
  const value = Promise.resolve().then(load);
  const entry = { expires: Infinity, value };
  entries.delete(key); entries.set(key, entry);
  while (entries.size > 256) entries.delete(entries.keys().next().value!);
  value.then(() => { entry.expires = Date.now() + ttl; }, () => { if (entries.get(key) === entry) entries.delete(key); });
  return value;
}
