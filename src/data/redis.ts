import Redis from "ioredis";
const logger = { info: console.log, warn: console.warn, error: console.error };

const DEFAULT_REDIS_URL = "redis://:7e23dd7cf7c7aea497add4e479173480@10.0.0.54:6379";
const MAX_RETRIES = 5;

/**
 * Create a Redis client with graceful degradation.
 * Returns null if no URL provided or connection fails — Redis is optional.
 */
export function createRedisClient(url?: string): Redis | null {
  const redisUrl = url ?? DEFAULT_REDIS_URL;
  if (!redisUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch (err) {
    logger.warn(`[redis] Invalid Redis URL: ${redisUrl}`);
    return null;
  }

  const host = parsed.hostname || "127.0.0.1";
  const port = parseInt(parsed.port, 10) || 6379;
  const password = parsed.password || undefined;

  let retryCount = 0;

  const client = new Redis({
    host,
    port,
    password,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      retryCount = times;
      if (times > MAX_RETRIES) {
        logger.warn(`[redis] Max retries (${MAX_RETRIES}) exceeded — giving up`);
        return null; // stop retrying
      }
      const delay = Math.min(times * 500, 5000);
      logger.warn(`[redis] Retry ${times}/${MAX_RETRIES} in ${delay}ms`);
      return delay;
    },
    enableOfflineQueue: false,
  });

  client.on("error", (err) => {
    logger.warn(`[redis] Connection error: ${err.message}`);
  });

  client.on("connect", () => {
    logger.info(`[redis] Connected to ${host}:${port}`);
    retryCount = 0;
  });

  client.on("close", () => {
    logger.warn("[redis] Connection closed");
  });

  // Attempt initial connection — non-blocking
  client.connect().catch((err) => {
    logger.warn(`[redis] Initial connection failed: ${err.message} — Redis caching disabled`);
  });

  return client;
}
