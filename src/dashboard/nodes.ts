// --- /nodes: every node as the host sees it and as Kubernetes sees it, side by side ---
// Two sources joined by node name: the devops-vm-agent's latest heartbeat snapshot (agent/vm,
// migrations/019 — memory, processes and systemd services OUTSIDE pods, root disk) and three MCP
// reads of the local cluster (k8s_list_nodes, k8s_node_pods per node, the leader Leases). It
// exists because a node's memory story needs both halves: on 2026-11-17/18 master3-vm and then
// master2-vm went MemoryPressure from etcd outside pods, a leader lease and the pods' allocatable,
// and no single page showed those three together.
//
// Structural types only: the dashboard never imports the agent's (see McpTool in server.ts).
// The loader never throws — what could not be read is listed in `unavailable`, and the page says so.

export interface HostRowLike {
  name: string;
  units: string[];
  version: string | null;
  lastSeenSeconds: number;
  snapshot: Record<string, unknown> | null;
  snapshotAgeSeconds: number | null;
}

export interface ActionRowLike {
  id: number;
  host: string;
  unit: string;
  action: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  exitCode: number | null;
}

export interface NodesSource {
  hosts(): Promise<HostRowLike[]>;
  actions(): Promise<ActionRowLike[]>;
  /** One MCP read against the local cluster; the raw tool result. */
  tool(name: string, args: Record<string, unknown>): Promise<string>;
}

/** Everything the page needs, as read — buildNodesModel() turns it into the model. */
export interface NodesInput {
  hosts: HostRowLike[];
  actions: ActionRowLike[];
  /** k8s_list_nodes rows, or null when the read failed. */
  nodes: Array<Record<string, unknown>> | null;
  /** k8s_node_pods per node name. */
  nodePods: Map<string, Record<string, unknown>>;
  /** Lease name → holderIdentity. */
  leases: Map<string, string>;
  unavailable: string[];
}

/** Snapshot older than this is from before the node or its agent went quiet. */
export const STALE_SECONDS = 180;
export const LEASES = [
  { lease: "kube-controller-manager", label: "controller-manager leader" },
  { lease: "kube-scheduler", label: "scheduler leader" },
  { lease: "plndr-cp-lock", label: "API VIP (kube-vip)" },
] as const;

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The page's data, read in parallel. Never throws; each failed read is named in `unavailable`. */
export async function loadNodes(src: NodesSource): Promise<NodesInput> {
  const unavailable: string[] = [];
  const soft = <T>(what: string, p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((err: unknown) => {
      unavailable.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    });
  const toolJson = async (what: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
    const raw = await soft(what, src.tool(name, args), "");
    if (!raw) return null;
    const v = parse(raw);
    if (v === null) unavailable.push(`${what}: ${raw.slice(0, 160)}`);
    return v;
  };

  const [hosts, actions, list, ...leaseRaw] = await Promise.all([
    soft("host snapshots", src.hosts(), [] as HostRowLike[]),
    soft("host actions", src.actions(), [] as ActionRowLike[]),
    toolJson("k8s_list_nodes", "k8s_list_nodes", {}),
    ...LEASES.map((l) =>
      toolJson(`Lease ${l.lease}`, "k8s_get_resource", { api_version: "coordination.k8s.io/v1", kind: "Lease", namespace: "kube-system", name: l.lease })
    ),
  ]);
  const nodes = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : null;
  const names = nodes?.map((n) => String(n.name ?? "")).filter(Boolean) ?? hosts.map((h) => h.name);
  const podsRaw = await Promise.all(names.map((n) => toolJson(`k8s_node_pods ${n}`, "k8s_node_pods", { name: n })));
  const nodePods = new Map<string, Record<string, unknown>>();
  names.forEach((n, i) => {
    const v = podsRaw[i];
    if (v && typeof v === "object" && !Array.isArray(v)) nodePods.set(n, v as Record<string, unknown>);
  });
  const leases = new Map<string, string>();
  LEASES.forEach((l, i) => {
    const holder = (leaseRaw[i] as { spec?: { holderIdentity?: unknown } } | null)?.spec?.holderIdentity;
    if (typeof holder === "string" && holder) leases.set(l.lease, holder);
  });
  return { hosts, actions, nodes, nodePods, leases, unavailable };
}

// ---------- the model ----------

export type Tone = "" | "ok" | "warning" | "critical";

export interface NodeCard {
  name: string;
  roles: string[];
  controlPlane: boolean;
  /** Leader leases this node holds, by label. */
  holds: string[];
  k8s: { ready: string | null; pressure: string[]; cordoned: boolean; taints: string[] } | null;
  /** Pods' working set against allocatable — the kubelet's pod-allocatable MemoryPressure signal. */
  pods: { count: number; workingSetMi: number; allocatableMi: number; headroomMi: number; tone: Tone } | null;
  agent: { version: string | null; lastSeenSeconds: number; units: string[] } | null;
  host: {
    ageSeconds: number;
    stale: boolean;
    totalMi: number;
    availableMi: number;
    anonMi: number;
    cacheMi: number;
    swap: string;
    allPodsMi: number | null;
    load: number[];
    uptimeHours: number | null;
    disk: { totalGi: number; availableGi: number; usedPct: number; tone: Tone } | null;
    services: Array<{ unit: string; mi: number }>;
    processes: Array<{ name: string; pid: number; mi: number; where: string }>;
  } | null;
  /** What on this card deserves a look, worst first. */
  flags: Array<{ text: string; tone: Tone }>;
}

export interface NodesModel {
  cards: NodeCard[];
  actions: ActionRowLike[];
  unavailable: string[];
  summary: { nodes: number; controlPlanes: number; underPressure: number; reporting: number; tightest: { node: string; headroomMi: number } | null };
}

const MI = 1048576;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const mi = (bytes: unknown): number => Math.round((num(bytes) ?? 0) / MI);

/** "1126100Ki", "700Mi", "1.5Gi", "2048" (bytes) → MiB; null when it is not a quantity. */
export function toMi(q: unknown): number | null {
  if (typeof q === "number") return Math.round(q / MI);
  if (typeof q !== "string") return null;
  const m = /^([0-9.]+)\s*(Ki|Mi|Gi|Ti|K|M|G)?$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const f: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / MI, M: 1e6 / MI, G: 1e9 / MI };
  return Math.round(m[2] ? n * f[m[2]]! : n / MI);
}

const headroomTone = (mi: number): Tone => (mi < 100 ? "critical" : mi < 200 ? "warning" : "ok");
const diskTone = (pct: number): Tone => (pct >= 85 ? "critical" : pct >= 75 ? "warning" : "ok");

export function buildNodesModel(input: NodesInput): NodesModel {
  const byHost = new Map(input.hosts.map((h) => [h.name, h]));
  const byNode = new Map((input.nodes ?? []).map((n) => [String(n.name ?? ""), n]));
  const names = [...new Set([...byNode.keys(), ...byHost.keys()])].filter(Boolean);
  // A holder is "<node>_<uuid>" for the controllers and the bare node name for kube-vip.
  const holds = (node: string): string[] =>
    LEASES.filter((l) => {
      const h = input.leases.get(l.lease);
      return h === node || h?.startsWith(`${node}_`);
    }).map((l) => l.label);

  const cards = names.map((name): NodeCard => {
    const n = byNode.get(name);
    const roles = Array.isArray(n?.roles) ? (n!.roles as unknown[]).map(String) : [];
    const controlPlane = roles.includes("control-plane") || roles.includes("master");
    const k8s = n
      ? {
          ready: typeof n.status === "string" ? n.status : null,
          pressure: Array.isArray(n.pressure) ? (n.pressure as unknown[]).map(String) : [],
          cordoned: n.unschedulable === true,
          taints: Array.isArray(n.taints) ? (n.taints as unknown[]).map(String) : [],
        }
      : null;

    const np = input.nodePods.get(name);
    const usage = (np?.usage ?? {}) as Record<string, unknown>;
    const wsMi = toMi(usage.podsWorkingSet);
    const allocMi = toMi((np?.allocatable as Record<string, unknown> | undefined)?.memory) ?? toMi((n?.allocatable as Record<string, unknown> | undefined)?.memory);
    const pods =
      wsMi !== null && allocMi !== null
        ? { count: num(np?.podsTotal) ?? 0, workingSetMi: wsMi, allocatableMi: allocMi, headroomMi: allocMi - wsMi, tone: headroomTone(allocMi - wsMi) }
        : null;

    const h = byHost.get(name);
    const s = h?.snapshot ?? null;
    const mem = (s?.memory ?? null) as Record<string, unknown> | null;
    const disk = (s?.rootDisk ?? null) as { totalBytes?: unknown; availableBytes?: unknown } | null;
    const diskTotal = num(disk?.totalBytes);
    const usedPct = diskTotal ? Math.round((1 - (num(disk?.availableBytes) ?? 0) / diskTotal) * 100) : null;
    const host =
      s && mem
        ? {
            ageSeconds: h!.snapshotAgeSeconds ?? h!.lastSeenSeconds,
            stale: (h!.snapshotAgeSeconds ?? Infinity) > STALE_SECONDS,
            totalMi: mi(mem.totalBytes),
            availableMi: mi(mem.availableBytes),
            anonMi: mi(mem.anonBytes),
            cacheMi: mi(mem.cachedBytes),
            swap: num(mem.swapTotalBytes) ? `${mi(mem.swapTotalBytes)}Mi (free ${mi(mem.swapFreeBytes)}Mi)` : "none",
            allPodsMi: num(s.kubepodsMemoryBytes) === null ? null : mi(s.kubepodsMemoryBytes),
            load: Array.isArray(s.load) ? (s.load as unknown[]).map(Number).filter(Number.isFinite) : [],
            uptimeHours: num(s.uptimeSeconds) === null ? null : Math.round(num(s.uptimeSeconds)! / 360) / 10,
            disk:
              diskTotal && usedPct !== null
                ? { totalGi: Math.round((diskTotal / 1073741824) * 10) / 10, availableGi: Math.round(((num(disk?.availableBytes) ?? 0) / 1073741824) * 10) / 10, usedPct, tone: diskTone(usedPct) }
                : null,
            services: (Array.isArray(s.units) ? (s.units as Array<Record<string, unknown>>) : []).map((u) => ({ unit: String(u.unit), mi: mi(u.memoryBytes) })),
            processes: (Array.isArray(s.processes) ? (s.processes as Array<Record<string, unknown>>) : []).map((p) => ({
              name: String(p.name),
              pid: num(p.pid) ?? 0,
              mi: mi(p.rssBytes),
              where: p.unit === "kubepods" ? "pod" : p.unit ? String(p.unit) : "—",
            })),
          }
        : null;

    const flags: NodeCard["flags"] = [];
    if (k8s && k8s.ready !== "True") flags.push({ text: `Ready: ${k8s.ready ?? "unknown"}`, tone: "critical" });
    for (const p of k8s?.pressure ?? []) flags.push({ text: p, tone: "critical" });
    if (pods && pods.tone !== "ok") flags.push({ text: `pods ${pods.headroomMi}Mi from allocatable`, tone: pods.tone });
    if (host?.disk && host.disk.tone !== "ok") flags.push({ text: `root disk ${host.disk.usedPct}%`, tone: host.disk.tone });
    if (host && host.availableMi < 200) flags.push({ text: `${host.availableMi}Mi available on the host`, tone: host.availableMi < 100 ? "critical" : "warning" });
    if (k8s?.cordoned) flags.push({ text: "cordoned", tone: "warning" });
    if (!h) flags.push({ text: "no devops-vm-agent reports here", tone: "warning" });
    else if (!s) flags.push({ text: `agent v${h.version ?? "?"} sends no snapshot`, tone: "warning" });
    else if (host?.stale) flags.push({ text: `snapshot ${host.ageSeconds}s old`, tone: "warning" });
    const rank: Record<Tone, number> = { critical: 0, warning: 1, ok: 2, "": 3 };
    flags.sort((a, b) => rank[a.tone] - rank[b.tone]);

    return {
      name,
      roles,
      controlPlane,
      holds: holds(name),
      k8s,
      pods,
      agent: h ? { version: h.version, lastSeenSeconds: h.lastSeenSeconds, units: h.units } : null,
      host,
      flags,
    };
  });
  cards.sort((a, b) => Number(b.controlPlane) - Number(a.controlPlane) || a.name.localeCompare(b.name));

  const withPods = cards.filter((c) => c.pods);
  const tight = withPods.sort((a, b) => a.pods!.headroomMi - b.pods!.headroomMi)[0];
  return {
    cards,
    actions: input.actions,
    unavailable: input.unavailable,
    summary: {
      nodes: cards.length,
      controlPlanes: cards.filter((c) => c.controlPlane).length,
      underPressure: cards.filter((c) => (c.k8s?.pressure.length ?? 0) > 0 || (c.k8s && c.k8s.ready !== "True")).length,
      reporting: cards.filter((c) => c.host && !c.host.stale).length,
      tightest: tight ? { node: tight.name, headroomMi: tight.pods!.headroomMi } : null,
    },
  };
}
