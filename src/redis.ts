import { Redis } from "ioredis";
import { config } from "./config/index.js";
import logger from "./utils/logger/index.js";

// Single process-wide Redis connection, shared by conversation memory and alert dedup.
// ponytail: module singleton — one connection per pod is exactly what we want; no DI needed.
let client: Redis | null = null;

// Connect once at startup. Returns null when MEMORY_BACKEND !== "redis".
// Fails fast (ping) so an unreachable Redis surfaces at boot, not on first alert.
export async function initRedis(): Promise<Redis | null> {
  if (config.memory.backend !== "redis") return null;
  if (client) return client;
  const { host, port, db, username, password, tls } = config.memory.redis;
  client = new Redis({ host, port, db, username, password, tls: tls ? {} : undefined });
  client.on("error", (err: Error) => logger.error(`Redis error: ${err.message}`));
  await client.ping();
  logger.info(`Redis connected ${host}:${port} db=${db} tls=${tls}`);
  return client;
}

// Accessor for code that runs after initRedis() (e.g. alert dedup). null if not configured.
export function getRedis(): Redis | null {
  return client;
}

// Cheap reachability check for /health. true only when configured AND PING succeeds.
export async function pingRedis(): Promise<boolean> {
  if (!client) return false;
  try {
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  }
}
