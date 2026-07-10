import { getRedis } from "../../redis.js";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — matches Alertmanager repeat_interval

export class AlertDeduplicator {
  private seen = new Map<string, number>(); // fingerprint → expiry timestamp (in-memory fallback)

  /**
   * Returns true if this alert should be processed (not a duplicate).
   * Marks it as seen for TTL duration.
   *
   * When Redis is configured, the claim is atomic across pods (SET NX) — under
   * autoscaling only the first pod to see an alert processes it; the rest skip.
   * Without Redis it falls back to a per-pod in-memory map (single-pod only).
   */
  async shouldProcess(labels: Record<string, string>, ttlMs = DEFAULT_TTL_MS): Promise<boolean> {
    const fingerprint = this.fingerprint(labels);
    const redis = getRedis();

    if (redis) {
      // SET key 1 EX <ttl> NX → "OK" if newly set (process), null if already present (duplicate).
      // Atomic, so two pods racing on the same alert can't both win.
      const claimed = await redis.set(`dedup:${fingerprint}`, "1", "EX", Math.ceil(ttlMs / 1000), "NX");
      return claimed === "OK";
    }

    const now = Date.now();
    const expiry = this.seen.get(fingerprint);
    if (expiry && now < expiry) return false;
    this.seen.set(fingerprint, now + ttlMs);
    this.cleanup(now);
    return true;
  }

  private fingerprint(labels: Record<string, string>): string {
    // stable sort keys so order doesn't matter
    return Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`)
      .join(",");
  }

  private cleanup(now: number): void {
    for (const [key, expiry] of this.seen) {
      if (now >= expiry) this.seen.delete(key);
    }
  }
}
