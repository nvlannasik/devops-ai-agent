// The work-queue primitives SlackApp runs every turn through (2026-10-21: out of app/index.ts):
// how many investigations run at once, one turn per thread at a time, and what this pod has
// accepted and not finished — so a shutdown can wait for it and say what it abandoned.

export class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

/**
 * Serialises work per Slack thread. The Semaphore above bounds how many investigations run
 * at once; this bounds how many run in ONE CONVERSATION, and the answer is one.
 *
 * A thread is a conversation, and its turns are ordered by the person having it. Running
 * two in parallel made the ordering an accident of latency: an approval card produced by
 * turn N arrived 40 seconds late, after the person had already asked turn N+1, and read as
 * a reply to a question it had never seen. It also let `lastAssistantText` — how a bare
 * "ya" is recognised as approving what the agent proposed in the turn before — read a reply
 * from a turn that had not finished being written.
 *
 * Cost, stated plainly: a follow-up asked mid-investigation now waits for that
 * investigation instead of running beside it. That is the trade this is: predictable order
 * over parallelism inside a single conversation. Different threads are untouched.
 */
export class ThreadQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** True while a turn for this thread is queued or running. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // .then(fn, fn) — a predecessor that REJECTED must still release its successor, or one
    // failed turn wedges the thread for the lifetime of the process.
    const result = prev.then(fn, fn);
    const tail = result.then(() => {}, () => {});
    this.tails.set(key, tail);
    // Only the current tail clears the entry. Without the identity check a slow turn
    // settling late would delete a newer turn's link and unserialise the thread.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * The work this pod has ACCEPTED and not yet finished — queued behind a thread's earlier turn or
 * running — so a shutdown can wait for it and name what it had to abandon.
 *
 * Live, 2026-09-29 07:00:44: a rollout's SIGTERM arrived mid-investigation ("unused resources for
 * mongodb"); shutdown closed MCP under it and exited, and the user heard nothing until they typed
 * "try again" 13 minutes later. An alert cut the same way never gets its RCA at all.
 */
export class InFlightWork<T> {
  private readonly work = new Map<Promise<unknown>, T>();

  track<R>(meta: T, p: Promise<R>): Promise<R> {
    this.work.set(p, meta);
    const settle = () => void this.work.delete(p);
    p.then(settle, settle);
    return p;
  }

  /** Waits up to `budgetMs` for tracked work to settle; returns what is still running. */
  async drain(budgetMs: number): Promise<T[]> {
    if (this.work.size === 0) return [];
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => (timer = setTimeout(resolve, budgetMs)));
    await Promise.race([Promise.allSettled([...this.work.keys()]), budget]);
    clearTimeout(timer);
    return [...this.work.values()];
  }
}

export type Accepted = { channel: string; threadTs: string; kind: "mention" | "alert" };

// Said in the thread that will otherwise never hear back. Nothing ran against the cluster that a
// re-run would repeat — investigations are read-only and remediation needs a human's click.
export const RESTART_NOTICE: Record<Accepted["kind"], string> = {
  mention: "⚠️ I restarted before I could answer this, so nothing was posted for it. Mention me again to re-run it.",
  alert: "⚠️ I restarted before this investigation finished, so no RCA was posted. Mention me in this thread to investigate it again.",
};
