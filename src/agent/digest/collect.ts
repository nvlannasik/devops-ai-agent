import type { VmStore } from "../vm/store.js";
import type { DigestStore } from "./store.js";
import { firingFrom, fluxFrom, hostDigest, localClock, type DigestData } from "./build.js";
import { readBalance, type BalanceParts } from "../vm/balance.js";

const TIMEOUT_MS = 20_000;
const HISTORY_HOURS = 168;

const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms).unref())]);
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);

export interface DigestDeps {
  vm: Pick<VmStore, "hosts" | "history">;
  store: Pick<DigestStore, "incidentCounts" | "openTotal">;
  /** An MCP tool call on the local cluster — Alertmanager, and Flux's objects through k8s_get_custom_resources. */
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

  const [hosts, incidents24h, repeat7d, openTotal, firing, gitops] = await Promise.all([
    read("host history", async () => {
      const list = await deps.vm.hosts();
      if (list.length === 0) return null;
      // A Kubernetes node is one whose snapshot shows the kubepods cgroup: the kubelet manages its disk.
      return Promise.all(
        list.map(async (h) => hostDigest(h.node ?? h.name, await deps.vm.history(h.name, HISTORY_HOURS), now, { kubernetes: typeof h.snapshot?.kubepodsMemoryBytes === "number" }))
      );
    }),
    read("incidents", () => deps.store.incidentCounts(24)),
    read("incidents (7 days)", () => deps.store.incidentCounts(HISTORY_HOURS, 3)),
    read("open incidents", () => deps.store.openTotal()),
    read("Alertmanager", async () => {
      const f = firingFrom(await deps.callTool("alertmanager_get_alerts", {}));
      if (f === null) throw new Error("unexpected answer");
      return f;
    }),
    read("Flux", async () => {
      const [hr, ks] = await Promise.all([
        deps.callTool("k8s_get_custom_resources", { group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases" }),
        deps.callTool("k8s_get_custom_resources", { group: "kustomize.toolkit.fluxcd.io", version: "v1", plural: "kustomizations" }),
      ]);
      const g = fluxFrom(hr, ks);
      if (g === null) throw new Error("unexpected answer");
      return g;
    }),
  ]);
  // The control plane after the hosts: it reads their memory. Leases and API load through MCP.
  const memory: BalanceParts["memory"] = new Map(
    (hosts ?? []).map((h) => [h.name, { ...(h.availableNow !== undefined ? { available: h.availableNow } : {}), ...(h.lowest24h ? { lowest: h.lowest24h.available } : {}), ...(h.total !== undefined ? { total: h.total } : {}) }])
  );
  const controlPlane = await read("control plane", async () => {
    const r = await readBalance(deps.callTool, memory, [...memory.keys()]);
    if (r?.unread.length) unread.push(...r.unread.map((u) => `control plane: ${u}`));
    return r;
  });
  // A source with nothing to say (no pool, no host agents) is absent, not unread.
  return { day: localClock(now, deps.timeZone).day, now, hosts, incidents24h, repeat7d, openTotal, firing, gitops, controlPlane, unread };
}
