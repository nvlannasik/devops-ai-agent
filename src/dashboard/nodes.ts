// --- /nodes: every host the devops-vm-agent reports, Kubernetes node or not, grouped by cluster ---
// Two sources joined per host: the agent's latest heartbeat snapshot (agent/vm, migrations/019-020 —
// memory, processes and systemd services OUTSIDE pods, root disk, and since vm-agent 4 the cluster and
// node name the host says it is) and, per cluster the agent can reach, three MCP reads
// (k8s_list_nodes, k8s_node_pods per node, the leader Leases). It exists because a node's memory
// story needs both halves: on 2026-11-17/18 master3-vm and then master2-vm went MemoryPressure from
// etcd outside pods, a leader lease and the pods' allocatable, and no single page showed them together.
//
// A host is placed in a cluster by what it says (vm-agent 4+); a host that says nothing (an older agent)
// by matching its name against each reachable cluster's nodes; else it is standalone — a machine
// outside any cluster, shown with its restart allowlist and last action instead of pods.
// One cluster that does not answer is marked unreachable and never blanks the others.
//
// Structural types only: the dashboard never imports the agent's (see McpTool in server.ts).
// The loader never throws — what could not be read is listed, and the page says so.

export interface HostRowLike {
  name: string;
  cluster?: string | null;
  node?: string | null;
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
  /** The clusters the agent can read; `names` empty = single-cluster mode (one unnamed cluster). */
  clusters(): { names: string[]; local: string | null };
  /** One MCP read against `cluster` (null: the local one); the raw tool result. */
  tool(cluster: string | null, name: string, args: Record<string, unknown>): Promise<string>;
  /** A host's history points (vm_host_history), for its page. Absent: no history section. */
  history?(host: string, hours: number): Promise<import("../agent/vm/history.js").StoredPoint[]>;
}

/** One cluster as read: nodes is null when the cluster did not answer. */
export interface ClusterRead {
  name: string | null;
  nodes: Array<Record<string, unknown>> | null;
  nodePods: Map<string, Record<string, unknown>>;
  /** Lease name → holderIdentity. */
  leases: Map<string, string>;
  unavailable: string[];
}

/** Everything the pages need, as read — buildNodesModel() turns it into the model. */
export interface NodesInput {
  hosts: HostRowLike[];
  actions: ActionRowLike[];
  clusters: ClusterRead[];
  local: string | null;
  unavailable: string[];
}

/** Snapshot older than this is from before the host or its agent went quiet. */
export const STALE_SECONDS = 180;
/** One cluster's reads may take this long before it is shown as unreachable. */
export const CLUSTER_TIMEOUT_MS = 12_000;
export const LEASES = [
  { lease: "kube-controller-manager", label: "controller-manager leader", short: "controller-manager" },
  { lease: "kube-scheduler", label: "scheduler leader", short: "scheduler" },
  { lease: "plndr-cp-lock", label: "API VIP (kube-vip)", short: "API VIP" },
] as const;
/** A cluster, node or host name as it may appear in a URL. */
export const HOST_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/;

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readCluster(src: NodesSource, name: string | null): Promise<ClusterRead> {
  const unavailable: string[] = [];
  const label = name ?? "cluster";
  const toolJson = async (what: string, tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const raw = await src.tool(name, tool, args).catch((err: unknown) => {
      unavailable.push(`${label}: ${what}: ${msg(err)}`);
      return "";
    });
    if (!raw) return null;
    const v = parse(raw);
    if (v === null) unavailable.push(`${label}: ${what}: ${raw.slice(0, 160)}`);
    return v;
  };
  const [list, ...leaseRaw] = await Promise.all([
    toolJson("k8s_list_nodes", "k8s_list_nodes", {}),
    ...LEASES.map((l) => toolJson(`Lease ${l.lease}`, "k8s_get_resource", { api_version: "coordination.k8s.io/v1", kind: "Lease", namespace: "kube-system", name: l.lease })),
  ]);
  const nodes = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : null;
  const names = nodes?.map((n) => String(n.name ?? "")).filter(Boolean) ?? [];
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
  return { name, nodes, nodePods, leases, unavailable };
}

/** The pages' data. Clusters are read in parallel, each under its own deadline. Never throws. */
export async function loadNodes(src: NodesSource, clusterTimeoutMs = CLUSTER_TIMEOUT_MS): Promise<NodesInput> {
  const unavailable: string[] = [];
  const soft = <T>(what: string, p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((err: unknown) => {
      unavailable.push(`${what}: ${msg(err)}`);
      return fallback;
    });
  const { names, local } = src.clusters();
  const wanted: Array<string | null> = names.length ? names : [null];
  const bounded = (name: string | null): Promise<ClusterRead> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<ClusterRead>((resolve) => {
      timer = setTimeout(
        () => resolve({ name, nodes: null, nodePods: new Map(), leases: new Map(), unavailable: [`${name ?? "cluster"}: did not answer within ${clusterTimeoutMs / 1000}s`] }),
        clusterTimeoutMs
      );
    });
    return Promise.race([readCluster(src, name), late]).finally(() => clearTimeout(timer));
  };
  const [hosts, actions, clusters] = await Promise.all([
    soft("host snapshots", src.hosts(), [] as HostRowLike[]),
    soft("host actions", src.actions(), [] as ActionRowLike[]),
    Promise.all(wanted.map(bounded)),
  ]);
  for (const c of clusters) unavailable.push(...c.unavailable);
  return { hosts, actions, clusters, local, unavailable };
}

// ---------- the model ----------

export type Tone = "" | "ok" | "warning" | "critical";

/** One segment of a control plane's memory budget, bottom (pods) to top (available). */
export interface BudgetPart {
  key: "apiserver" | "controller" | "pods" | "etcd" | "runtime" | "os" | "free";
  label: string;
  mi: number;
}

export interface NodeCard {
  /** The host's agent name when one reports, else the Kubernetes node name. */
  id: string;
  /** The Kubernetes node name (or the host's name for a standalone host). */
  name: string;
  /** The cluster group it is shown in; null = standalone. */
  cluster: string | null;
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
  /** A control plane's whole memory as one budget (control planes with both halves only). */
  budget: { parts: BudgetPart[]; totalMi: number; allocatableMi: number } | null;
  lastAction: ActionRowLike | null;
  /** What on this card deserves a look, worst first. */
  flags: Array<{ text: string; tone: Tone }>;
}

export interface ClusterGroup {
  name: string;
  reachable: boolean;
  /** Why the Kubernetes half is missing, when it is. */
  note: string | null;
  /** Lease label → holder node. */
  holders: Array<{ label: string; node: string }>;
  cards: NodeCard[];
}

export interface NodesModel {
  clusters: ClusterGroup[];
  standalone: NodeCard[];
  actions: ActionRowLike[];
  unavailable: string[];
  summary: { hosts: number; clusters: number; standalone: number; needLook: string[]; unreachable: string[]; reporting: number };
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

const headroomTone = (v: number): Tone => (v < 100 ? "critical" : v < 200 ? "warning" : "ok");
const diskTone = (pct: number): Tone => (pct >= 85 ? "critical" : pct >= 75 ? "warning" : "ok");
const RANK: Record<Tone, number> = { critical: 0, warning: 1, ok: 2, "": 3 };
export const worstTone = (c: NodeCard): Tone => c.flags[0]?.tone ?? "";
const needsLook = (c: NodeCard): boolean => c.flags.some((f) => f.tone === "warning" || f.tone === "critical");

function hostHalf(h: HostRowLike | undefined): NodeCard["host"] {
  const s = h?.snapshot ?? null;
  const mem = (s?.memory ?? null) as Record<string, unknown> | null;
  if (!h || !s || !mem) return null;
  const disk = (s.rootDisk ?? null) as { totalBytes?: unknown; availableBytes?: unknown } | null;
  const diskTotal = num(disk?.totalBytes);
  const usedPct = diskTotal ? Math.round((1 - (num(disk?.availableBytes) ?? 0) / diskTotal) * 100) : null;
  return {
    ageSeconds: h.snapshotAgeSeconds ?? h.lastSeenSeconds,
    stale: (h.snapshotAgeSeconds ?? Infinity) > STALE_SECONDS,
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
  };
}

/** The machine's memory split from the pods up: the control plane's own pods, the rest of the pods,
 *  etcd, the runtime, the OS, and what is left. Each part is clamped at zero — the two halves are read
 *  a few seconds apart and from different counters, so the arithmetic can come out a little negative. */
function budgetOf(host: NonNullable<NodeCard["host"]>, pods: NonNullable<NodeCard["pods"]>): NonNullable<NodeCard["budget"]> {
  const proc = (prefix: string) => host.processes.filter((p) => p.where === "pod" && p.name.startsWith(prefix)).reduce((a, p) => a + p.mi, 0);
  const svc = (unit: string) => host.services.find((s) => s.unit === unit)?.mi ?? 0;
  const apiserver = proc("kube-apiserver");
  const controller = proc("kube-controller");
  const otherPods = Math.max(0, pods.workingSetMi - apiserver - controller);
  const etcd = svc("etcd.service") || host.processes.filter((p) => p.name === "etcd" && p.where !== "pod").reduce((a, p) => a + p.mi, 0);
  const runtime = svc("containerd.service") + svc("kubelet.service");
  const used = Math.max(0, host.totalMi - host.availableMi);
  const os = Math.max(0, used - pods.workingSetMi - etcd - runtime);
  const parts: BudgetPart[] = [
    { key: "apiserver", label: "kube-apiserver", mi: apiserver },
    { key: "controller", label: "controller-manager", mi: controller },
    { key: "pods", label: "other pods", mi: otherPods },
    { key: "etcd", label: "etcd (systemd)", mi: etcd },
    { key: "runtime", label: "containerd + kubelet", mi: runtime },
    { key: "os", label: "OS & other", mi: os },
    { key: "free", label: "available", mi: host.availableMi },
  ];
  return { parts: parts.filter((p) => p.mi > 0 || p.key === "free"), totalMi: host.totalMi, allocatableMi: pods.allocatableMi };
}

function card(
  id: string,
  name: string,
  cluster: string | null,
  h: HostRowLike | undefined,
  n: Record<string, unknown> | undefined,
  np: Record<string, unknown> | undefined,
  holds: string[],
  lastAction: ActionRowLike | null,
  kubernetesKnown: boolean
): NodeCard {
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
  const usage = (np?.usage ?? {}) as Record<string, unknown>;
  const wsMi = toMi(usage.podsWorkingSet);
  const allocMi = toMi((np?.allocatable as Record<string, unknown> | undefined)?.memory) ?? toMi((n?.allocatable as Record<string, unknown> | undefined)?.memory);
  const pods =
    wsMi !== null && allocMi !== null
      ? { count: num(np?.podsTotal) ?? 0, workingSetMi: wsMi, allocatableMi: allocMi, headroomMi: allocMi - wsMi, tone: headroomTone(allocMi - wsMi) }
      : null;
  const host = hostHalf(h);

  const flags: NodeCard["flags"] = [];
  if (k8s && k8s.ready !== "True") flags.push({ text: `Ready: ${k8s.ready ?? "unknown"}`, tone: "critical" });
  for (const p of k8s?.pressure ?? []) flags.push({ text: p, tone: "critical" });
  if (pods && pods.tone !== "ok") flags.push({ text: `pods ${pods.headroomMi}Mi from allocatable`, tone: pods.tone });
  if (host?.disk && host.disk.tone !== "ok") flags.push({ text: `root disk ${host.disk.usedPct}%`, tone: host.disk.tone });
  if (host && host.availableMi < 200) flags.push({ text: `${host.availableMi}Mi available on the host`, tone: host.availableMi < 100 ? "critical" : "warning" });
  if (k8s?.cordoned) flags.push({ text: "cordoned", tone: "warning" });
  if (cluster && kubernetesKnown && !n) flags.push({ text: "not a node of this cluster", tone: "warning" });
  if (!h) flags.push({ text: "no devops-vm-agent reports here", tone: "warning" });
  else if (!h.snapshot) flags.push({ text: `agent v${h.version ?? "?"} sends no snapshot`, tone: "warning" });
  else if (host?.stale) flags.push({ text: `snapshot ${host.ageSeconds}s old`, tone: "warning" });
  if (lastAction && (lastAction.status === "failed" || lastAction.status === "refused")) flags.push({ text: `last restart ${lastAction.status}`, tone: "warning" });
  flags.sort((a, b) => RANK[a.tone] - RANK[b.tone]);

  return {
    id,
    name,
    cluster,
    roles,
    controlPlane,
    holds,
    k8s,
    pods,
    agent: h ? { version: h.version, lastSeenSeconds: h.lastSeenSeconds, units: h.units } : null,
    host,
    budget: controlPlane && host && pods ? budgetOf(host, pods) : null,
    lastAction,
    flags,
  };
}

const byAttention = (a: NodeCard, b: NodeCard): number =>
  RANK[worstTone(a)] - RANK[worstTone(b)] || Number(b.controlPlane) - Number(a.controlPlane) || a.name.localeCompare(b.name);

export function buildNodesModel(input: NodesInput): NodesModel {
  const lastAction = new Map<string, ActionRowLike>();
  for (const a of input.actions) if (!lastAction.has(a.host)) lastAction.set(a.host, a); // newest first
  const nodeOf = (h: HostRowLike): string => h.node ?? h.name;
  const listed = (c: ClusterRead, node: string): boolean => (c.nodes ?? []).some((n) => String(n.name ?? "") === node);
  const groupName = (c: ClusterRead): string => c.name ?? input.local ?? "cluster";

  // Place every host: what it says, else the one reachable cluster that lists it, else — while the
  // local cluster cannot be read — the local cluster (every pre-v4 host was one of its nodes), else standalone.
  const placed = new Map<string, HostRowLike[]>();
  const standaloneHosts: HostRowLike[] = [];
  const localRead = input.clusters.find((c) => c.name === input.local) ?? (input.clusters.length === 1 ? input.clusters[0] : undefined);
  for (const h of input.hosts) {
    let where: string | null = h.cluster ?? null;
    if (!where) {
      const hits = input.clusters.filter((c) => listed(c, nodeOf(h)));
      if (hits.length) where = groupName(hits.find((c) => c.name === input.local) ?? hits[0]!);
      // A version-4 agent that names no cluster says it is standalone; an older one cannot say.
      else if (localRead && localRead.nodes === null && !(Number(h.version) >= 4)) where = groupName(localRead);
    }
    if (where) placed.set(where, [...(placed.get(where) ?? []), h]);
    else standaloneHosts.push(h);
  }

  const groups: ClusterGroup[] = input.clusters.map((c) => {
    const name = groupName(c);
    const hosts = placed.get(name) ?? [];
    placed.delete(name);
    const byNode = new Map(hosts.map((h) => [nodeOf(h), h]));
    const k8sNames = (c.nodes ?? []).map((n) => String(n.name ?? "")).filter(Boolean);
    const nodeNames = [...new Set([...k8sNames, ...byNode.keys()])];
    const holders = LEASES.flatMap((l) => {
      const who = c.leases.get(l.lease);
      if (!who) return [];
      const node = nodeNames.find((n) => who === n || who.startsWith(`${n}_`)) ?? who.replace(/_[^_]+$/, "");
      return [{ label: l.short, node }];
    });
    const cards = nodeNames.map((node) => {
      const h = byNode.get(node);
      const holds = LEASES.filter((l) => holders.some((x) => x.label === l.short && x.node === node)).map((l) => l.label);
      return card(h?.name ?? node, node, name, h, (c.nodes ?? []).find((n) => n.name === node), c.nodePods.get(node), holds, h ? (lastAction.get(h.name) ?? null) : null, c.nodes !== null);
    });
    cards.sort(byAttention);
    const note = c.nodes === null ? (c.unavailable.find((u) => /did not answer|k8s_list_nodes/.test(u)) ?? "the cluster did not answer").replace(/^[^:]+: /, "") : null;
    return { name, reachable: c.nodes !== null, note, holders, cards };
  });
  // Hosts naming a cluster the agent cannot read at all: their own group, host half only.
  for (const [name, hosts] of placed) {
    const cards = hosts.map((h) => card(h.name, nodeOf(h), name, h, undefined, undefined, [], lastAction.get(h.name) ?? null, false)).sort(byAttention);
    groups.push({ name, reachable: false, note: "not in the agent's cluster registry (MCP_LOCAL_CLUSTER / MCP_*_CLUSTERS)", holders: [], cards });
  }
  const standalone = standaloneHosts.map((h) => card(h.name, h.name, null, h, undefined, undefined, [], lastAction.get(h.name) ?? null, false)).sort(byAttention);

  const all = [...groups.flatMap((g) => g.cards), ...standalone];
  return {
    clusters: groups,
    standalone,
    actions: input.actions,
    unavailable: input.unavailable,
    summary: {
      hosts: all.length,
      clusters: groups.length,
      standalone: standalone.length,
      needLook: all.filter(needsLook).map((c) => (c.cluster ? `${c.name}` : c.name)),
      unreachable: groups.filter((g) => !g.reachable).map((g) => g.name),
      reporting: all.filter((c) => c.host && !c.host.stale).length,
    },
  };
}
