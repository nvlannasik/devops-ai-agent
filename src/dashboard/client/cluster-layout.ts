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
  owner: { width: 240, height: 52 },
};

export type ClusterFlowNode = Node<ClusterNodeData, "cluster">;

/**
 * Left to right: host → Service → workload → owner. A `manages` edge points owner → workload (the
 * owner manages it), but dagre ranks by edge direction, so for LAYOUT it is given reversed — that
 * is what puts owners after their workloads instead of in front of the hosts.
 */
export function layoutClusterGraph(graph: ClusterGraph): { nodes: ClusterFlowNode[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  // /topology's measured values: every pixel between ranks is width the fit then scales away.
  g.setGraph({ rankdir: "LR", ranksep: 72, nodesep: 16, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { ...CLUSTER_NODE_SIZE[n.data.kind] });
  for (const e of graph.edges) {
    if (e.kind === "manages") g.setEdge(e.target, e.source);
    else g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const nodes = graph.nodes.map((n): ClusterFlowNode => {
    const { width, height } = CLUSTER_NODE_SIZE[n.data.kind];
    const pos = g.node(n.id);
    return { id: n.id, type: "cluster", position: { x: pos.x - width / 2, y: pos.y - height / 2 }, data: n.data, width, height };
  });
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
