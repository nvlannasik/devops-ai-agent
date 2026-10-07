/**
 * The cluster map's graph, from the k8s_cluster_inventory payload (spec 2026-10-08-cluster-map).
 *
 * Built in the CLIENT from the inventory embedded in the page, as topology-graph.ts' buildGraph is:
 * expanding a namespace recomputes it without a reload. Pure, and imports types only, so it runs
 * in node for the tests and in the browser bundle with nothing of the server reachable from it.
 *
 * Every edge comes from a relation the mcp-server computed — `serves` (selector ↔ pod-template
 * labels) and `backends` (Ingress → Service) — or from `managedBy`. Nothing is inferred from names.
 */
import type { ClusterInventory, ClusterNamespace, ManagedBy } from "./cluster-types.js";

// `panel` is added by the layout (client/cluster-layout.ts), never here: it frames an open
// namespace's cards and carries its column headings.
export type ClusterNodeKind = "namespace" | "host" | "service" | "workload" | "owner" | "panel" | "panelHead";
export interface ClusterNodeData { kind: ClusterNodeKind; label: string; sub?: string; namespace: string; tone?: "warning"; expanded?: boolean; [k: string]: unknown }
export interface ClusterNode { id: string; data: ClusterNodeData }
export interface ClusterEdge { id: string; source: string; target: string; kind: "routes" | "manages" }
export interface ClusterGraph { nodes: ClusterNode[]; edges: ClusterEdge[] }

export const nsId = (ns: string): string => `ns/${ns}`;
const wlId = (ns: string, name: string) => `wl/${ns}/${name}`;
const svcId = (ns: string, name: string) => `svc/${ns}/${name}`;
const hostId = (ns: string, host: string) => `host/${ns}/${host}`;

/** One owner node per distinct owner IN this namespace — two HelmReleases called `app` stay two. */
// The name is the label and the kind of owner the subtitle: "HelmRelease flux-app/checkout-gateway"
// as one line was cut at every card width that kept the opening zoom (2026-10-08).
function ownerOf(ns: string, m: ManagedBy): { id: string; label: string; sub?: string; tone?: "warning" } {
  if (m.type === "helmrelease") return { id: `owner/${ns}/helmrelease/${m.namespace}/${m.name}`, label: `${m.namespace}/${m.name}`, sub: "HelmRelease" };
  if (m.type === "kustomization") return { id: `owner/${ns}/kustomization/${m.namespace}/${m.name}`, label: `${m.namespace}/${m.name}`, sub: "Kustomization" };
  if (m.type === "helm") return { id: `owner/${ns}/helm`, label: "Helm", sub: "release without Flux" };
  return { id: `owner/${ns}/unmanaged`, label: "not managed by GitOps", sub: "applied by hand", tone: "warning" };
}

function card(n: ClusterNamespace, open: boolean): ClusterNode {
  const unmanaged = n.workloads.filter((w) => w.managedBy.type === "unmanaged").length;
  return {
    id: nsId(n.name),
    data: {
      kind: "namespace",
      label: n.name,
      sub: `${n.workloads.length} workloads${unmanaged > 0 ? ` · ${unmanaged} outside GitOps` : ""}`,
      namespace: n.name,
      expanded: open,
    },
  };
}

export function buildClusterGraph(inv: ClusterInventory, expanded: ReadonlySet<string>, showSystem: boolean): ClusterGraph {
  const nodes = new Map<string, ClusterNode>();
  const edges = new Map<string, ClusterEdge>();
  const node = (id: string, data: ClusterNodeData) => { if (!nodes.has(id)) nodes.set(id, { id, data }); };
  const edge = (kind: ClusterEdge["kind"], source: string, target: string) => {
    const id = `${kind}:${source}>${target}`;
    if (!edges.has(id)) edges.set(id, { id, source, target, kind });
  };

  for (const n of inv.namespaces.filter((x) => showSystem || !x.system)) {
    // The card stays in the grid when its namespace is open, marked as such: a card that vanished
    // on click left readers looking for it (feedback 2026-10-08).
    const open = expanded.has(nsId(n.name));
    const c = card(n, open);
    nodes.set(c.id, c);
    if (!open) continue;
    const ns = n.name;
    const workloads = new Set(n.workloads.map((w) => w.name));
    for (const w of n.workloads) {
      const sub = w.schedule ? `${w.kind} · ${w.schedule}` : `${w.kind} · ${w.ready ?? "?"}/${w.desired ?? "?"}`;
      node(wlId(ns, w.name), { kind: "workload", label: w.name, sub, namespace: ns });
      const o = ownerOf(ns, w.managedBy);
      node(o.id, { kind: "owner", label: o.label, namespace: ns, ...(o.sub ? { sub: o.sub } : {}), ...(o.tone ? { tone: o.tone } : {}) });
      edge("manages", o.id, wlId(ns, w.name));
    }
    const services = new Set(n.services.map((s) => s.name));
    for (const s of n.services) {
      node(svcId(ns, s.name), { kind: "service", label: s.name, sub: s.ports.join(", "), namespace: ns });
      for (const w of s.serves ?? []) if (workloads.has(w)) edge("routes", svcId(ns, s.name), wlId(ns, w));
    }
    for (const i of n.ingresses) {
      for (const b of i.backends ?? []) {
        if (!services.has(b.service)) continue;
        node(hostId(ns, b.host), { kind: "host", label: b.host === "*" ? "any host" : b.host, namespace: ns });
        edge("routes", hostId(ns, b.host), svcId(ns, b.service));
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
