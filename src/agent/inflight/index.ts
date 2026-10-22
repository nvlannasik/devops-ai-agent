import type { Redis } from "ioredis";
import { getRedis } from "../../db/redis.js";
import logger from "../../utils/logger/index.js";

// Alert investigations still running, shared across replicas (2026-10-22).
//
// The incident row is written with the RCA, minutes after the alert. Until then the only record
// of the investigation is the investigating pod's own `unstored` map — so, with two replicas, a
// related alert landing on the OTHER pod opened its own thread instead of correlating, and a
// resolve landing there found nothing and waited for the reconciler. This mirrors each entry to
// Redis, so the other pod can see it and hand it the resolve.
//
// The investigating pod's map stays the source of truth for its own entries: this is a mirror
// for the others. Every call fails open — no Redis, or a Redis error, is exactly the old
// single-pod behaviour, and an alert is never lost to it.

/** The one Redis key prefix this module writes. See REDIS_KEYS in agent/memory for why these are named. */
export const REDIS_KEYS = {
  inflight: { prefix: "inflight", holds: "alert investigations still running, per thread, 15m" },
} as const;

/** Longer than INVESTIGATION_TIMEOUT_SECONDS (300) plus the store: a pod that dies mid-run leaves nothing behind for long. */
const TTL_SECONDS = 15 * 60;

/** What another replica needs: correlation's candidate fields, and the resolve held for it. */
export interface InFlightEntry {
  key: string;
  channel?: string;
  namespace?: string;
  subjects?: string[];
  startedAt?: number;
  alertname?: string;
  resolved?: unknown[];
}

type RedisLike = Pick<Redis, "set" | "get" | "del" | "mget" | "scan">;

const keyOf = (threadTs: string) => `${REDIS_KEYS.inflight.prefix}:${threadTs}`;

export class InFlightRegistry {
  constructor(private readonly redis: () => RedisLike | null = getRedis) {}

  async publish(threadTs: string, entry: InFlightEntry): Promise<void> {
    await this.safely("publish", undefined, async (r) => {
      await r.set(keyOf(threadTs), JSON.stringify(entry), "EX", TTL_SECONDS);
    });
  }

  async remove(threadTs: string): Promise<void> {
    await this.safely("remove", undefined, async (r) => {
      await r.del(keyOf(threadTs));
    });
  }

  /** Every entry in Redis, this pod's own included — the caller drops the ones it already holds. */
  async remote(): Promise<Map<string, InFlightEntry>> {
    return this.safely("remote", new Map<string, InFlightEntry>(), async (r) => {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await r.scan(cursor, "MATCH", `${REDIS_KEYS.inflight.prefix}:*`, "COUNT", 100);
        keys.push(...batch);
        cursor = next;
      } while (cursor !== "0");
      const out = new Map<string, InFlightEntry>();
      if (keys.length === 0) return out;
      const values = await r.mget(...keys);
      keys.forEach((k, i) => {
        const v = values[i];
        if (!v) return; // expired between SCAN and MGET
        try {
          out.set(k.slice(REDIS_KEYS.inflight.prefix.length + 1), JSON.parse(v) as InFlightEntry);
        } catch {
          // a value this module never wrote: not an investigation
        }
      });
      return out;
    });
  }

  /** Hold `resolved` for the investigation of alert `key`: its thread, or null when nobody is investigating it. */
  async markResolved(key: string, resolved: unknown[]): Promise<string | null> {
    const match = [...(await this.remote())].find(([, e]) => e.key === key);
    if (!match) return null;
    const [threadTs, entry] = match;
    return this.safely("markResolved", null, async (r) =>
      (await r.set(keyOf(threadTs), JSON.stringify({ ...entry, resolved }), "KEEPTTL")) === "OK" ? threadTs : null
    );
  }

  /** A resolve another replica held for this thread's investigation, if any. */
  async resolvedFor(threadTs: string): Promise<unknown[] | undefined> {
    return this.safely("resolvedFor", undefined, async (r) => {
      const v = await r.get(keyOf(threadTs));
      return v ? (JSON.parse(v) as InFlightEntry).resolved : undefined;
    });
  }

  private async safely<T>(op: string, fallback: T, fn: (r: RedisLike) => Promise<T>): Promise<T> {
    const r = this.redis();
    if (!r) return fallback;
    try {
      return await fn(r);
    } catch (err) {
      logger.warn(`[inflight] ${op} failed — this pod sees only its own investigations: ${err instanceof Error ? err.message : err}`);
      return fallback;
    }
  }
}
