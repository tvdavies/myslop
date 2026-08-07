const CACHE_TTL_MS = 20_000;
const CACHE_MAX_ENTRIES = 32;

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function readRouteResourceCache<T>(key: string, now = Date.now()): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) return undefined;
  return entry.data as T;
}

export function writeRouteResourceCache<T>(key: string, data: T, now = Date.now()): void {
  cache.delete(key);
  cache.set(key, { data, expiresAt: now + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearRouteResourceCache(): void {
  cache.clear();
}
