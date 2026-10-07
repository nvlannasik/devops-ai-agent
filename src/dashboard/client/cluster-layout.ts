import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { ClusterGraph, ClusterNodeData, ClusterNodeKind } from "../cluster-graph.js";

// One size table, read by the layout and the cards alike — dagre needs the box before React lays
// anything out. Widths are the opening-zoom budget: on /topology WIDTH bound the fit, not height.
export const CLUSTER_NODE_SIZE: Record<ClusterNodeKind, { width: number; height: number }> = {
  namespace: { width: 260, height: 64 },
  workload: { width: 220, height: 56 },
  service: { width: 200, height: 52 },
  host: { width: 220, height: 44 },
  owner: { width: 280, height: 52 }, // "HelmRelease flux-app/checkout-gateway" truncated at 240
};

export type ClusterFlowNode = Node<ClusterNodeData, "cluster">;

const GAP = 16;
const BLOCK_GAP = 32;

/**
 * Collapsed namespaces are a GRID, in name order, four per row (two in a narrow frame). They have no edges between them,
 * and dagre given edgeless nodes stacks them in one rank — on the live cluster (2026-10-08) that
 * was a single column of 17 cards and an opening zoom of 0.47. Each expanded namespace is then
 * laid out on its own by dagre (left to right: host → Service → workload → owner) and placed as a
 * block below the grid, so opening one never moves the cards of another.
 *
 * A `manages` edge points owner → workload, but dagre ranks by edge direction, so for LAYOUT it is
 * given reversed — that is what puts owners after their workloads instead of in front of the hosts.
 */
export function layoutClusterGraph(graph: ClusterGraph, cols = 4): { nodes: ClusterFlowNode[]; edges: Edge[] } {
  const place = (n: ClusterGraph["nodes"][number], x: number, y: number): ClusterFlowNode => {
    const { width, height } = CLUSTER_NODE_SIZE[n.data.kind];
    return { id: n.id, type: "cluster", position: { x, y }, data: n.data, width, height };
  };
  const nodes: ClusterFlowNode[] = [];

  const cards = graph.nodes.filter((n) => n.data.kind === "namespace").sort((a, b) => a.data.label.localeCompare(b.data.label));
  const card = CLUSTER_NODE_SIZE.namespace;
  cards.forEach((n, i) => nodes.push(place(n, (i % cols) * (card.width + GAP), Math.floor(i / cols) * (card.height + GAP))));
  let top = cards.length ? Math.ceil(cards.length / cols) * (card.height + GAP) - GAP + BLOCK_GAP : 0;

  const byNs = new Map<string, ClusterGraph["nodes"]>();
  for (const n of graph.nodes) if (n.data.kind !== "namespace") byNs.set(n.data.namespace, [...(byNs.get(n.data.namespace) ?? []), n]);
  for (const ns of [...byNs.keys()].sort()) {
    const members = byNs.get(ns)!;
    const ids = new Set(members.map((n) => n.id));
    const g = new dagre.graphlib.Graph();
    // /topology's measured values: every pixel between ranks is width the fit then scales away.
    g.setGraph({ rankdir: "LR", ranksep: 72, nodesep: GAP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of members) g.setNode(n.id, { ...CLUSTER_NODE_SIZE[n.data.kind] });
    for (const e of graph.edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) continue;
      if (e.kind === "manages") g.setEdge(e.target, e.source);
      else g.setEdge(e.source, e.target);
    }
    dagre.layout(g);
    let bottom = 0;
    for (const n of members) {
      const { width, height } = CLUSTER_NODE_SIZE[n.data.kind];
      const pos = g.node(n.id);
      nodes.push(place(n, pos.x - width / 2, top + pos.y - height / 2));
      bottom = Math.max(bottom, pos.y + height / 2);
    }
    top += bottom + BLOCK_GAP;
  }

  // Drawn workload → owner too: an owner sits to the RIGHT, and an edge from its right-hand source
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
