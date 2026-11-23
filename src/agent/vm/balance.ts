// Control-plane balance (B3, 2026-11-24): which master holds the leader roles, how the API's
// long-running requests (watches) spread across the API servers, and whether the busiest master is
// also the one with the least memory. MemoryPressure moved from master3-vm to master2-vm in
// November; read live on 2026-11-24, master3-vm held the controller-manager lease AND the API VIP,
// served 328 watches against 238 and 188, and had the least headroom of the three. Leader roles move
// only when a control-plane component restarts — never the agent's to do (agent/remediation/
// unsafe-advice) — so this says what it sees and where the fix lies, and proposes nothing.

export const LEADER_LEASES = [
  { lease: "kube-controller-manager", role: "controller-manager" },
  { lease: "kube-scheduler", role: "scheduler" },
  { lease: "plndr-cp-lock", role: "API VIP (kube-vip)" },
] as const;

/** A lease holder identity → node name: `master3-vm_39d0…` or `master3-vm` (the dashboard's rule). */
export function holderNode(holder: string, nodes: string[]): string {
  return nodes.find((n) => holder === n || holder.startsWith(`${n}_`)) ?? holder.replace(/_[^_]+$/, "");
}

type Vector = Array<{ metric?: Record<string, string>; value?: [number, string] }>;
const vector = (raw: string): Vector | null => {
  try {
    const v = JSON.parse(raw) as { result?: unknown; data?: { result?: unknown } };
    const r = Array.isArray(v?.result) ? v.result : Array.isArray(v?.data?.result) ? v.data!.result : null;
    return r as Vector | null;
  } catch {
    return null;
  }
};

export interface BalanceParts {
  /** Role → holder node, for the leases that could be read. */
  roles: Array<{ role: string; node: string }>;
  /** Node → its API server's long-running requests (watches) and resident memory. */
  api: Map<string, { watches?: number; rss?: number }>;
  /** Node → memory available now / lowest in 24 h, and total (bytes) — host reports. */
  memory: Map<string, { available?: number; lowest?: number; total?: number }>;
  unread: string[];
}

/** The raw reads → parts. `leases[i]` is k8s_get_resource's answer for LEADER_LEASES[i] (or null); the three PromQL answers are prometheus_query's. */
export function balanceParts(
  leases: Array<string | null>,
  watchesRaw: string | null,
  rssRaw: string | null,
  kubeletRaw: string | null,
  nodes: string[],
  memory: BalanceParts["memory"]
): BalanceParts {
  const unread: string[] = [];
  const roles: BalanceParts["roles"] = [];
  LEADER_LEASES.forEach((l, i) => {
    let holder: unknown;
    try {
      holder = (JSON.parse(leases[i] ?? "") as { spec?: { holderIdentity?: unknown } })?.spec?.holderIdentity;
    } catch {
      holder = undefined;
    }
    if (typeof holder === "string" && holder) roles.push({ role: l.role, node: holderNode(holder, nodes) });
    else unread.push(`lease ${l.lease}`);
  });
  // instance (ip:6443) → node, through the kubelet job's node/node_ip labels
  const ipNode = new Map<string, string>();
  for (const r of (kubeletRaw ? vector(kubeletRaw) : null) ?? []) {
    if (r.metric?.node_ip && r.metric?.node) ipNode.set(r.metric.node_ip, r.metric.node);
  }
  const api = new Map<string, { watches?: number; rss?: number }>();
  const put = (raw: string | null, field: "watches" | "rss", what: string) => {
    const v = raw ? vector(raw) : null;
    if (!v) return void unread.push(what);
    for (const r of v) {
      const ip = (r.metric?.instance ?? "").replace(/:\d+$/, "");
      const node = ipNode.get(ip) ?? ip;
      const n = Number(r.value?.[1]);
      if (!node || !Number.isFinite(n)) continue;
      api.set(node, { ...(api.get(node) ?? {}), [field]: n });
    }
  };
  put(watchesRaw, "watches", "API server watches (prometheus)");
  put(rssRaw, "rss", "API server memory (prometheus)");
  return { roles, api, memory, unread };
}

const mi = (b: number) => `${Math.round(b / 1048576)}Mi`;

export interface BalanceReport {
  rows: Array<{ node: string; roles: string[]; watches?: number; apiserverMemory?: string; available?: string; lowest24h?: string; total?: string }>;
  findings: string[];
  unread: string[];
}

/** Rows per control-plane node and what stands out. Null when fewer than two control planes are known. */
export function controlPlaneBalance(p: BalanceParts): BalanceReport | null {
  const nodes = [...new Set([...p.roles.map((r) => r.node), ...p.api.keys()])].sort();
  if (nodes.length < 2) return null;
  const rows = nodes.map((node) => {
    const a = p.api.get(node) ?? {};
    const m = p.memory.get(node) ?? {};
    return {
      node,
      roles: p.roles.filter((r) => r.node === node).map((r) => r.role),
      ...(a.watches !== undefined ? { watches: a.watches } : {}),
      ...(a.rss !== undefined ? { apiserverMemory: mi(a.rss) } : {}),
      ...(m.available !== undefined ? { available: mi(m.available) } : {}),
      ...(m.lowest !== undefined ? { lowest24h: mi(m.lowest) } : {}),
      ...(m.total !== undefined ? { total: mi(m.total) } : {}),
    };
  });
  const findings: string[] = [];
  const busiest = [...rows].sort((a, b) => b.roles.length - a.roles.length)[0]!;
  const concentrated = busiest.roles.length >= 2;
  if (concentrated) {
    const vip = busiest.roles.some((r) => r.startsWith("API VIP")) ? " — the API VIP alone sends it every request from outside the cluster" : "";
    findings.push(`\`${busiest.node}\` holds ${busiest.roles.length} of ${LEADER_LEASES.length} leader roles (${busiest.roles.join(", ")})${vip}`);
  }
  const w = rows.filter((r) => r.watches !== undefined).sort((a, b) => b.watches! - a.watches!);
  const uneven = w.length >= 2 && w[w.length - 1]!.watches! > 0 && w[0]!.watches! / w[w.length - 1]!.watches! >= 1.5;
  if (uneven) {
    findings.push(`\`${w[0]!.node}\` serves ${w[0]!.watches} long-running API requests (watches) against ${w[w.length - 1]!.watches} on \`${w[w.length - 1]!.node}\` — the load does not spread`);
  }
  // The loaded one — by roles, else by watches, and only when one of those stood out — is also the
  // one with the least memory? Evenly spread, the least memory is just the smallest machine.
  const loaded = concentrated ? busiest.node : uneven ? w[0]!.node : null;
  const mem = (n: string) => p.memory.get(n)?.lowest ?? p.memory.get(n)?.available;
  const withMem = nodes.filter((n) => mem(n) !== undefined).sort((a, b) => mem(a)! - mem(b)!);
  if (loaded && withMem.length >= 2 && withMem[0] === loaded) {
    findings.push(
      `⚠️ and \`${loaded}\` has the least memory of the control planes (${mi(mem(loaded)!)}) — expect MemoryPressure there first. ` +
        `Leader roles move only when a control-plane component restarts, which is not a fix to make: more memory for that machine, ` +
        `or spreading the API traffic (kube-vip, the workers' local load balancer), is.`
    );
  }
  return { rows, findings, unread: p.unread };
}

/** The PromQL the parts are read from — one place, so the digest and the tool ask the same thing. */
export const BALANCE_QUERIES = {
  watches: 'sum by (instance) (apiserver_longrunning_requests{job="kubernetes-apiservers"})',
  rss: 'max by (instance) (process_resident_memory_bytes{job="kubernetes-apiservers"})',
  kubelet: 'max by (node, node_ip) (up{job="kubernetes-kubelet-monitoring"})',
} as const;

/** Reads everything through MCP tools; never throws — a source that fails is `unread`. */
export async function readBalance(
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  memory: BalanceParts["memory"],
  nodes: string[]
): Promise<BalanceReport | null> {
  const safe = (p: Promise<string>) => p.then((r) => (/^Error:/.test(r) ? null : r)).catch(() => null);
  const [leases, watches, rss, kubelet] = await Promise.all([
    Promise.all(LEADER_LEASES.map((l) => safe(callTool("k8s_get_resource", { api_version: "coordination.k8s.io/v1", kind: "Lease", namespace: "kube-system", name: l.lease })))),
    safe(callTool("prometheus_query", { query: BALANCE_QUERIES.watches })),
    safe(callTool("prometheus_query", { query: BALANCE_QUERIES.rss })),
    safe(callTool("prometheus_query", { query: BALANCE_QUERIES.kubelet })),
  ]);
  return controlPlaneBalance(balanceParts(leases, watches, rss, kubelet, nodes, memory));
}
