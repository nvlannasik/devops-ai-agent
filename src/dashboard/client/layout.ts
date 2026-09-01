import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { TopoGraph, TopoNodeData, TopoNodeKind } from "../topology-graph.js";

// Auto-layout, replacing the hand-laid coordinate table the SVG map used to carry. The old
// note said a layout engine "would solve a problem this page does not have", and that was true
// while the node count was bounded and every position was a constant. It stopped being true
// the moment nodes became draggable: a reader who drags a card wants the rest to still make
// sense, and there is no hand-laid answer for "where does the twenty-first backend go".
//
// rankdir LR because the reading order is the claim: callers fan IN on the left, the agent is
// the middle, its dependencies fan OUT on the right, and the two shelves hang off whichever
// dependency actually reaches them. dagre ranks by edge direction, so that shape falls out of
// buildGraph()'s edges rather than being asserted here a second time.

// One size table, read by BOTH the layout and the node components. dagre needs the box before
// React has rendered anything, so the number cannot come from measurement — which means the
// component and this table have to agree, and the only way to make that cheap is for there to
// be exactly one of them. `nodes.tsx` imports these; do not restate them in CSS.
export const NODE_SIZE: Record<TopoNodeKind, { width: number; height: number }> = {
  // The three structural boxes carry a full endpoint as their caption, so they get the width.
  inbound: { width: 216, height: 64 },
  agent: { width: 216, height: 64 },
  outbound: { width: 216, height: 64 },
  // A backend carries a THIRD line — name, model, and the route chip — so it is the one card
  // that needs the extra height; a capability carries one word and a count. Same reasoning as
  // the old CHIP_MIN_W / CAP_MIN_W split, which is why these are still two numbers and not one.
  // These are the box `.topo-node` is painted into, and it clips: a height that does not fit
  // its three lines cuts the title in half, top and bottom, because the card centres its
  // content. Measured against the shipped type scale, not guessed.
  backend: { width: 190, height: 76 },
  capability: { width: 150, height: 56 },
};

export type TopoFlowNode = Node<TopoNodeData, "topo">;
export type TopoFlowEdge = Edge;

/**
 * Positions every node and hands back the arrays React Flow renders.
 *
 * dagre reports a node's CENTRE; React Flow positions by top-left. Converting here rather than
 * in the component means nothing downstream has to remember which convention it is holding —
 * an off-by-half-a-box is the kind of bug that looks like a layout opinion.
 */
export function layoutGraph(graph: TopoGraph): { nodes: TopoFlowNode[]; edges: TopoFlowEdge[] } {
  const g = new dagre.graphlib.Graph();
  // ranksep is generous and nodesep is not: the columns are the argument this map makes, so
  // the gap BETWEEN ranks has to read as a step while the gap within one stays a list.
  g.setGraph({ rankdir: "LR", ranksep: 96, nodesep: 20, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) g.setNode(n.id, { ...NODE_SIZE[n.data.kind] });
  for (const e of graph.edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const nodes: TopoFlowNode[] = graph.nodes.map((n) => {
    const size = NODE_SIZE[n.data.kind];
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "topo",
      data: n.data,
      position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
      // Measured up front for the same reason the size table exists: React Flow otherwise
      // measures on first paint, and a fitView that runs before that lands on the wrong box.
      width: size.width,
      height: size.height,
    };
  });

  const edges: TopoFlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "smoothstep",
    // The one moving thing on the page, and it is spent on the single fact this map exists to
    // state: an animated edge is a hop through SQS and another pod. Everything else is a
    // direct call and stays still. If every edge animated, none of them would say anything.
    animated: e.kind === "sqs",
    className: e.kind === "sqs" ? "topo-edge topo-edge-sqs" : "topo-edge",
  }));

  return { nodes, edges };
}
