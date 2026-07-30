import { createClient, type RedisClientType } from "redis";
import type { ReputationMetrics } from "./store.js";

export type CachedReputation = ReputationMetrics & { address: string };

const TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "velo:reputation:";

type MemoryEntry = { value: CachedReputation; expiresAt: number };

const memoryCache = new Map<string, MemoryEntry>();

let redisClient: any = null;
let redisReady: Promise<any> | null = null;

async function getRedis(): Promise<any> {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (redisClient?.isOpen) return redisClient;
  if (redisReady) return redisReady;

  redisReady = (async () => {
    try {
      const client = createClient({ url });
      client.on("error", () => {
        /* fall back to memory on redis errors */
      });
      await client.connect();
      redisClient = client;
      return client;
    } catch {
      redisClient = null;
      return null;
    } finally {
      redisReady = null;
    }
  })();

  return redisReady;
}

function memoryGet(key: string): CachedReputation | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(key: string, value: CachedReputation): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + TTL_SECONDS * 1000 });
}

/** Read reputation from Redis, falling back to an in-memory TTL map. */
export async function getCachedReputation(
  address: string,
): Promise<CachedReputation | null> {
  const key = CACHE_KEY_PREFIX + address;

  try {
    const redis = await getRedis();
    if (redis) {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw) as CachedReputation;
      return null;
    }
  } catch {
    /* use memory fallback */
  }

  return memoryGet(key);
}

/** Write reputation into Redis (or memory) with a 60s TTL. */
export async function setCachedReputation(
  value: CachedReputation,
): Promise<void> {
  const key = CACHE_KEY_PREFIX + value.address;

  try {
    const redis = await getRedis();
    if (redis) {
      await redis.set(key, JSON.stringify(value), { EX: TTL_SECONDS });
      return;
    }
  } catch {
    /* use memory fallback */
  }

  memorySet(key, value);
}

/** Test helper — clears the in-memory cache and disconnects Redis. */
export async function clearReputationCache(): Promise<void> {
  memoryCache.clear();
  if (redisClient?.isOpen) {
    try {
      await redisClient.quit();
    } catch {
      /* ignore */
    }
  }
  redisClient = null;
  redisReady = null;
}
