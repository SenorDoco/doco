export type SenorDocoIntegrationProvider = "slack" | "telegram" | "google-chat" | "other";

export interface SenorDocoIntegrationContextCacheInfo {
  status: "hit" | "miss";
  key: string;
  ttlMs: number;
  cachedAt: number;
}

export interface SenorDocoIntegrationContextCacheResult<T> {
  value: T;
  cache: SenorDocoIntegrationContextCacheInfo;
}

export interface SenorDocoIntegrationContextKeyInput {
  provider: SenorDocoIntegrationProvider;
  workspaceId: string;
  channelId?: string | null;
  actorId?: string | null;
}

interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  lastUsedAt: number;
}

export function buildSenorDocoIntegrationContextKey(
  input: SenorDocoIntegrationContextKeyInput,
): string {
  return [input.provider, input.workspaceId, input.channelId ?? "*", input.actorId ?? "*"]
    .map(encodeIntegrationCachePart)
    .join(":");
}

export function createSenorDocoIntegrationContextCache<T>(options: {
  ttlMs: number;
  maxEntries?: number;
}) {
  const ttlMs = Math.max(1, options.ttlMs);
  const maxEntries = Math.max(1, options.maxEntries ?? 500);
  const entries = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<SenorDocoIntegrationContextCacheResult<T>>>();

  async function getOrLoad(
    key: string,
    load: () => Promise<T>,
    nowMs = Date.now(),
  ): Promise<SenorDocoIntegrationContextCacheResult<T>> {
    const existing = entries.get(key);
    if (existing && nowMs - existing.cachedAt < ttlMs) {
      existing.lastUsedAt = nowMs;
      return {
        value: existing.value,
        cache: { status: "hit", key, ttlMs, cachedAt: existing.cachedAt },
      };
    }

    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const value = await load();
      entries.set(key, { value, cachedAt: nowMs, lastUsedAt: nowMs });
      trimOldestEntries(entries, maxEntries);
      return {
        value,
        cache: { status: "miss" as const, key, ttlMs, cachedAt: nowMs },
      };
    })().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return {
    getOrLoad,
    clear: () => {
      entries.clear();
      inFlight.clear();
    },
    invalidateKey: (key: string) => {
      entries.delete(key);
      inFlight.delete(key);
    },
    invalidateWhere: (predicate: (key: string) => boolean) => {
      for (const key of entries.keys()) {
        if (predicate(key)) entries.delete(key);
      }
      for (const key of inFlight.keys()) {
        if (predicate(key)) inFlight.delete(key);
      }
    },
    size: () => entries.size,
  };
}

function encodeIntegrationCachePart(value: string): string {
  return encodeURIComponent(value.trim() || "*");
}

function trimOldestEntries<T>(entries: Map<string, CacheEntry<T>>, maxEntries: number): void {
  if (entries.size <= maxEntries) return;
  const oldest = [...entries.entries()]
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    .slice(0, entries.size - maxEntries);
  for (const [key] of oldest) entries.delete(key);
}
