import type { VmStore } from "../vm/store.js";
import type { DigestStore } from "./store.js";
import { firingFrom, hostDigest, localClock, type DigestData } from "./build.js";

const TIMEOUT_MS = 20_000;
const HISTORY_HOURS = 168;

const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms).unref())]);
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);

export interface DigestDeps {
  vm: Pick<VmStore, "hosts" | "history">;
  store: Pick<DigestStore, "incidentCounts" | "openTotal">;
  /** A central (non-Kubernetes) MCP tool call — Alertmanager. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  timeZone: string;
  now?: Date;
  timeoutMs?: number;
}

/** Every source in parallel, each under its own deadline; one that fails is listed in `unread`, never shown as empty. */
export async function collectDigest(deps: DigestDeps): Promise<DigestData> {
  const now = deps.now ?? new Date();
  const ms = deps.timeoutMs ?? TIMEOUT_MS;
  const unread: string[] = [];
  const read = <T>(label: string, p: () => Promise<T | null>): Promise<T | null> =>
    within(ms, p()).catch((e) => (unread.push(`${label} (${why(e)})`), null));

  const [hosts, incidents24h, repeat7d, openTotal, firing] = await Promise.all([
    read("host history", async () => {
      const list = await deps.vm.hosts();
      if (list.length === 0) return null;
      return Promise.all(list.map(async (h) => hostDigest(h.node ?? h.name, await deps.vm.history(h.name, HISTORY_HOURS), now)));
    }),
    read("incidents", () => deps.store.incidentCounts(24)),
    read("incidents (7 days)", () => deps.store.incidentCounts(HISTORY_HOURS, 3)),
    read("open incidents", () => deps.store.openTotal()),
    read("Alertmanager", async () => {
      const f = firingFrom(await deps.callTool("alertmanager_get_alerts", {}));
      if (f === null) throw new Error("unexpected answer");
      return f;
    }),
  ]);
  // A source with nothing to say (no pool, no host agents) is absent, not unread.
  return { day: localClock(now, deps.timeZone).day, now, hosts, incidents24h, repeat7d, openTotal, firing, unread };
}
