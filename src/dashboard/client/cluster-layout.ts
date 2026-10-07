import type { Edge, Node } from "@xyflow/react";
import type { ClusterGraph, ClusterNodeData, ClusterNodeKind } from "../cluster-graph.js";

// One size table, read by the layout and the cards alike — the layout needs the box before React
// lays anything out. Inside an open namespace every card is ROW_H tall, so one row is one line.
// Widths are the opening-zoom budget: on /topology WIDTH bound the fit, not height.
const ROW_H = 56;
export const CLUSTER_NODE_SIZE: Record<ClusterNodeKind, { width: number; height: number }> = {
  namespace: { width: 260, height: 64 },
  host: { width: 220, height: ROW_H },
  service: { width: 200, height: ROW_H },
  workload: { width: 220, height: ROW_H },
  owner: { width: 280, height: ROW_H }, // "HelmRelease flux-app/checkout-gateway" truncated at 240
  panel: { width: 0, height: 0 }, // sized to what it frames
  panelHead: { width: 0, height: 0 }, // as wide as its panel
};

export type ClusterFlowNode = Node<ClusterNodeData, "cluster">;

const GAP = 16;
const BLOCK_GAP = 32;
const LANE_GAP = 56;
const ROW = ROW_H + GAP;
const PAD = 16;
const HEADER = 72; // the panel's title line and its column headings
export const LANES: ReadonlyArray<{ kind: ClusterNodeKind; label: string }> = [
  { kind: "host", label: "Ingress host" },
  { kind: "service", label: "Service" },
  { kind: "workload", label: "Workload" },
  { kind: "owner", label: "Managed by" },
];

/**
 * Collapsed namespaces are a GRID, in name order, four per row (two in a narrow frame): they have
 * no edges between them, and a graph layout given edgeless nodes stacks them in one rank — on the
 * live cluster (2026-10-08) a single column of 17 cards opened at zoom 0.47.
 *
 * An open namespace is a PANEL below the grid, with one fixed LANE per kind — Ingress host,
 * Service, Workload, Managed by — and one row per workload. The first version let dagre rank each
 * row, so a row with no Ingress host slid left and its Service sat under the host heading; a
 * reader called it dizzying (2026-10-08). Now a card's x is its kind and its y is its workload's
 * row: a Service sits on the row of the first workload it serves, a host on the row of the first
 * Service it routes to, an owner on the row of its first workload. A Service that serves nothing
 * gets a row of its own after the workloads. Opening a namespace never moves another's cards.
 */
export function layoutClusterGraph(graph: ClusterGraph, cols = 4): { nodes: ClusterFlowNode[]; edges: Edge[] } {
  const nodes: ClusterFlowNode[] = [];
  const place = (n: ClusterGraph["nodes"][number], x: number, y: number): ClusterFlowNode => {
    const { width, height } = CLUSTER_NODE_SIZE[n.data.kind];
    return { id: n.id, type: "cluster", position: { x, y }, data: n.data, width, height };
  };

  const cards = graph.nodes.filter((n) => n.data.kind === "namespace").sort((a, b) => a.data.label.localeCompare(b.data.label));
  const card = CLUSTER_NODE_SIZE.namespace;
  cards.forEach((n, i) => nodes.push(place(n, (i % cols) * (card.width + GAP), Math.floor(i / cols) * (card.height + GAP))));
  let top = cards.length ? Math.ceil(cards.length / cols) * (card.height + GAP) - GAP + BLOCK_GAP : 0;

  const laneX = new Map<ClusterNodeKind, number>();
  let x = 0;
  for (const l of LANES) {
    laneX.set(l.kind, x);
    x += CLUSTER_NODE_SIZE[l.kind].width + LANE_GAP;
  }
  const lanesWidth = x - LANE_GAP;

  const byNs = new Map<string, ClusterGraph["nodes"]>();
  for (const n of graph.nodes) if (n.data.kind !== "namespace") byNs.set(n.data.namespace, [...(byNs.get(n.data.namespace) ?? []), n]);
  for (const ns of [...byNs.keys()].sort()) {
    const members = byNs.get(ns)!;
    const ids = new Set(members.map((n) => n.id));
    const local = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const servicesOf = (wl: string) => local.filter((e) => e.kind === "routes" && e.target === wl).map((e) => e.source);
    const hostsOf = (svc: string) => local.filter((e) => e.kind === "routes" && e.target === svc).map((e) => e.source);
    const ownerOf = (wl: string) => local.find((e) => e.kind === "manages" && e.target === wl)?.source;

    const slot = new Map<string, number>();
    let next = 0;
    const span = (lists: string[][]) => Math.max(1, ...lists.map((l) => l.length));
    const placeAt = (list: string[], from: number) => list.forEach((id, i) => slot.set(id, from + i));
    for (const w of members.filter((n) => n.data.kind === "workload")) {
      const svcs = servicesOf(w.id).filter((s) => !slot.has(s));
      const hosts = svcs.flatMap(hostsOf).filter((h, i, all) => !slot.has(h) && all.indexOf(h) === i);
      slot.set(w.id, next);
      placeAt(svcs, next);
      placeAt(hosts, next);
      const o = ownerOf(w.id);
      if (o && !slot.has(o)) slot.set(o, next);
      next += span([svcs, hosts]);
    }
    for (const s of members.filter((n) => n.data.kind === "service" && !slot.has(n.id))) {
      const hosts = hostsOf(s.id).filter((h) => !slot.has(h));
      slot.set(s.id, next);
      placeAt(hosts, next);
      next += span([hosts]);
    }
    for (const n of members) if (!slot.has(n.id)) slot.set(n.id, next++); // nothing should reach this; nothing is dropped if it does

    const rows = Math.max(1, next);
    const panelX = -PAD;
    const panelW = lanesWidth + 2 * PAD;
    const panelH = HEADER + rows * ROW - GAP + PAD;
    const workloads = members.filter((n) => n.data.kind === "workload").length;
    const label = { label: ns, sub: `${workloads} workload${workloads === 1 ? "" : "s"}`, namespace: ns };
    // Two nodes, because a zIndex -1 node sits under React Flow's pane and nothing in it can be
    // clicked (the ✕ could not be, 2026-10-08): the FRAME is behind the edges and takes no
    // pointer; the HEADER is a normal node above the pane. Nothing is drawn under the header, so
    // it hides no edge.
    nodes.push({
      id: `panel/${ns}`, type: "cluster", position: { x: panelX, y: top }, width: panelW, height: panelH,
      zIndex: -1, draggable: false, selectable: false, focusable: false,
      data: { kind: "panel", ...label },
    });
    nodes.push({
      id: `panel-head/${ns}`, type: "cluster", position: { x: panelX, y: top }, width: panelW, height: HEADER - GAP,
      // Not draggable and not selectable means React Flow sets pointer-events: none on the node, and
      // the ✕ inside it was un-clickable — every click reached the pane (measured, 2026-10-08).
      draggable: false, selectable: false, style: { pointerEvents: "all" },
      data: { kind: "panelHead", ...label, columns: LANES.map((l) => ({ label: l.label, x: laneX.get(l.kind)! - panelX })) },
    });
    for (const n of members) nodes.push(place(n, laneX.get(n.data.kind) ?? 0, top + HEADER + slot.get(n.id)! * ROW));
    top += panelH + BLOCK_GAP;
  }

  // Drawn workload → owner: an owner sits to the RIGHT, and an edge out of its right-hand source
  // handle into the workload's left-hand target would loop around both cards. The edge has no
  // arrowhead, so which end is "source" is not visible; the dash says what it means.
  const edges = graph.edges.map((e): Edge => ({
    id: e.id,
    source: e.kind === "manages" ? e.target : e.source,
    target: e.kind === "manages" ? e.source : e.target,
    type: "smoothstep",
    ...(e.kind === "manages" ? { style: { strokeDasharray: "6 4" } } : {}),
  }));
  return { nodes, edges };
}
