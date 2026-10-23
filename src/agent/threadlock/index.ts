import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { getRedis } from "../../db/redis.js";
import logger from "../../utils/logger/index.js";

// One turn per Slack thread ACROSS replicas (2026-10-23). ThreadQueue (app/queue.ts) serialises
// a thread inside one pod; with two pods, Socket Mode hands consecutive events to either, and a
// correlation follow-up can land on the pod that is not investigating. Two turns of one
// conversation then ran at once: both appended to its memory, and the later one answered first.
//
// A lease, not a lock held forever: SET NX PX, renewed while the turn runs, released by a
// compare-then-delete so a late release never frees a turn another pod has since taken. A pod
// that dies without releasing frees the thread when its lease runs out. Every failure — no
// Redis, a Redis error, waiting past maxWaitMs — lets the turn run: a stuck thread is worse than
// the single-pod behaviour this falls back to.

/** The one Redis key prefix this module writes. See REDIS_KEYS in agent/memory for why these are named. */
export const REDIS_KEYS = {
  threadlock: { prefix: "threadlock", holds: "which pod is running a Slack thread's turn, 60s lease" },
} as const;

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

type RedisLike = Pick<Redis, "set" | "get" | "eval">;

export interface ThreadLockOptions {
  pollMs?: number;
  leaseMs?: number;
  renewMs?: number;
  /** A thread held longer than this is followed anyway, with a warning. */
  maxWaitMs?: number;
}

const keyOf = (thread: string) => `${REDIS_KEYS.threadlock.prefix}:${thread}`;
const noop = async () => {};

export class ThreadLock {
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly redis: () => RedisLike | null = getRedis, opts: ThreadLockOptions = {}) {
    this.pollMs = opts.pollMs ?? 500;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.renewMs = opts.renewMs ?? 20_000;
    this.maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
  }

  /** Wait for the thread, then hold it. Resolves to the release. */
  async acquire(thread: string): Promise<() => Promise<void>> {
    const r = this.redis();
    if (!r) return noop;
    const key = keyOf(thread);
    const token = randomUUID();
    const until = Date.now() + this.maxWaitMs;
    try {
      while ((await r.set(key, token, "PX", this.leaseMs, "NX")) !== "OK") {
        if (Date.now() >= until) {
          logger.warn(`[threadlock] thread ${thread} still held by another pod after ${Math.round(this.maxWaitMs / 1000)}s — running this turn anyway`);
          return noop;
        }
        await new Promise((res) => setTimeout(res, this.pollMs));
      }
    } catch (err) {
      logger.warn(`[threadlock] could not take thread ${thread} — serialising inside this pod only: ${err instanceof Error ? err.message : err}`);
      return noop;
    }
    const renew = setInterval(() => {
      r.eval(RENEW, 1, key, token, this.leaseMs).catch((err: unknown) =>
        logger.warn(`[threadlock] lease renewal failed for thread ${thread}: ${err instanceof Error ? err.message : err}`)
      );
    }, this.renewMs);
    renew.unref();
    return async () => {
      clearInterval(renew);
      await r.eval(RELEASE, 1, key, token).catch((err: unknown) =>
        logger.warn(`[threadlock] release failed for thread ${thread} — its lease expires on its own: ${err instanceof Error ? err.message : err}`)
      );
    };
  }

  /** Whether some pod holds the thread right now. False when unknown. */
  async held(thread: string): Promise<boolean> {
    const r = this.redis();
    if (!r) return false;
    try {
      return (await r.get(keyOf(thread))) !== null;
    } catch {
      return false;
    }
  }
}
