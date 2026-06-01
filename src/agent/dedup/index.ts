const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — matches Alertmanager repeat_interval

export class AlertDeduplicator {
  private seen = new Map<string, number>(); // fingerprint → expiry timestamp

  /**
   * Returns true if this alert should be processed (not a duplicate).
   * Marks it as seen for TTL duration.
   */
  shouldProcess(labels: Record<string, string>, ttlMs = DEFAULT_TTL_MS): boolean {
    const fingerprint = this.fingerprint(labels);
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
