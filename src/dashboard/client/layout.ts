import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { TopoGraph, TopoNode, TopoNodeData, TopoNodeKind } from "../topology-graph.js";

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
//
// One thing is NOT left to dagre: an open tool family. See the note above layoutGraph().

// One size table, read by BOTH the layout and the node components. dagre needs the box before
// React has rendered anything, so the number cannot come from measurement — which means the
// component and this table have to agree, and the only way to make that cheap is for there to
// be exactly one of them. `nodes.tsx` imports these; do not restate them in CSS.
export const NODE_SIZE: Record<TopoNodeKind, { width: number; height: number }> = {
  // The three structural boxes carry a full endpoint as their caption, so they get the width.
  // 240 rather than 216 because the glyph takes 1.25rem out of the title's line: at 216 the
  // longest label this map actually has, "Redis (conversation memory)", came back truncated the
  // moment icons landed. The card pays for the icon; the label does not.
  inbound: { width: 240, height: 64 },
  agent: { width: 240, height: 64 },
  outbound: { width: 240, height: 64 },
  // A backend carries a THIRD line — name, model, and the route chip — so it is the one card
  // that needs the extra height; a capability carries one word and a count. Same reasoning as
  // the old CHIP_MIN_W / CAP_MIN_W split, which is why these are still two numbers and not one.
  // These are the box `.topo-node` is painted into, and it clips: a height that does not fit
  // its three lines cuts the title in half, top and bottom, because the card centres its
  // content. Measured against the shipped type scale, not guessed.
  backend: { width: 190, height: 76 },
  capability: { width: 150, height: 56 },
  // A tool is one identifier and nothing else, so it is the narrow one — but the identifiers
  // are long (`prometheus_list_metric_names`) and there can be 34 of them under one family, so
  // this is where the map's density is decided. Wider and k8s alone pushes the frame past any
  // useful zoom; narrower and every name ellipses to uselessness. `--font-data` at --fs-2xs
  // fits ~26 characters at 200px, which covers all but a handful.
  tool: { width: 200, height: 34 },
  // A store carries two lines — the table or namespace, and what it holds / which migration
  // introduced it — so it is taller than a tool and wider, because "conversation history, per
  // Slack thread" is a phrase rather than an identifier.
  store: { width: 230, height: 46 },
};

/** The leaf kinds: reached by expanding the card above them, and laid out as a block rather
 *  than a rank for the reason in the note over layoutGraph(). */
const isLeaf = (kind: TopoNodeKind): boolean => kind === "tool" || kind === "store";

export type TopoFlowNode = Node<TopoNodeData, "topo">;
export type TopoFlowEdge = Edge;

/**
 * Positions every node and hands back the arrays React Flow renders.
 *
 * dagre reports a node's CENTRE; React Flow positions by top-left. Converting here rather than
 * in the component means nothing downstream has to remember which convention it is holding —
 * an off-by-half-a-box is the kind of bug that looks like a layout opinion.
 */
// Leaves — a family's tools, a store's tables — are laid out as a BLOCK, not as a rank. dagre would stack a family's tools in one
// column — 34 of them under k8s is ~1400px of vertical, which pushed the rest of the map off
// screen the first time it was tried. So each open family is handed to dagre as ONE synthetic
// node sized to the whole block: dagre reserves the space and keeps everything else clear of
// it, and the tools are dealt into a grid inside that reservation afterwards.
const GRID_GAP = 6;

// Columns for a roughly square block. A tool card is wide and short (200x34), so a square
// block is not a square count: solving cols*W == (n/cols)*H for cols gives sqrt(n*H/W).
// 34 tools -> 3 columns of 12, which is 612x474 rather than 200x1400.
function gridCols(n: number, kind: TopoNodeKind): number {
  const { width: w, height: h } = NODE_SIZE[kind];
  return Math.max(1, Math.round(Math.sqrt((n * (h + GRID_GAP)) / (w + GRID_GAP))));
}

function gridSize(n: number, kind: TopoNodeKind): { width: number; height: number; cols: number; rows: number } {
  const cols = gridCols(n, kind);
  const rows = Math.ceil(n / cols);
  const { width: w, height: h } = NODE_SIZE[kind];
  return {
    cols,
    rows,
    width: cols * w + (cols - 1) * GRID_GAP,
    height: rows * h + (rows - 1) * GRID_GAP,
  };
}

export function layoutGraph(graph: TopoGraph): { nodes: TopoFlowNode[]; edges: TopoFlowEdge[] } {
  // A tool's family comes from the EDGE that reaches it, never from parsing its id: the id
  // format is an implementation detail of buildGraph and this would be the second place that
  // knew it.
  const parentOfTool = new Map<string, string>();
  for (const e of graph.edges) {
    const target = graph.nodes.find((n) => n.id === e.target);
    if (target !== undefined && isLeaf(target.data.kind)) parentOfTool.set(e.target, e.source);
  }
  const toolsByParent = new Map<string, TopoNode[]>();
  for (const n of graph.nodes) {
    if (!isLeaf(n.data.kind)) continue;
    const parent = parentOfTool.get(n.id);
    if (!parent) continue;
    const list = toolsByParent.get(parent) ?? [];
    list.push(n);
    toolsByParent.set(parent, list);
  }

  const g = new dagre.graphlib.Graph();
  // ranksep is generous and nodesep is not: the columns are the argument this map makes, so
  // the gap BETWEEN ranks has to read as a step while the gap within one stays a list.
  g.setGraph({ rankdir: "LR", ranksep: 96, nodesep: 20, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) {
    if (isLeaf(n.data.kind)) continue;
    g.setNode(n.id, { ...NODE_SIZE[n.data.kind] });
  }
  // One reservation per open family, edged from it so dagre ranks it just past its parent.
  const blockId = (parent: string): string => `__tools__${parent}`;
  for (const [parent, tools] of toolsByParent) {
    const { width, height } = gridSize(tools.length, tools[0]!.data.kind);
    g.setNode(blockId(parent), { width, height });
    g.setEdge(parent, blockId(parent));
  }
  for (const e of graph.edges) {
    if (parentOfTool.has(e.target)) continue; // represented by the block above
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const nodes: TopoFlowNode[] = [];
  for (const n of graph.nodes) {
    if (isLeaf(n.data.kind)) continue;
    const size = NODE_SIZE[n.data.kind];
    const pos = g.node(n.id);
    nodes.push({
      id: n.id,
      type: "topo",
      data: n.data,
      position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
      // Measured up front for the same reason the size table exists: React Flow otherwise
      // measures on first paint, and a fitView that runs before that lands on the wrong box.
      width: size.width,
      height: size.height,
    });
  }
  // Deal each family's tools into its reservation, reading order: left to right, then down.
  for (const [parent, tools] of toolsByParent) {
    const block = g.node(blockId(parent));
    const kind = tools[0]!.data.kind;
    const { cols, width, height } = gridSize(tools.length, kind);
    const { width: w, height: h } = NODE_SIZE[kind];
    const left = block.x - width / 2;
    const top = block.y - height / 2;
    tools.forEach((n, i) => {
      nodes.push({
        id: n.id,
        type: "topo",
        data: n.data,
        position: {
          x: left + (i % cols) * (w + GRID_GAP),
          y: top + Math.floor(i / cols) * (h + GRID_GAP),
        },
        width: w,
        height: h,
      });
    });
  }

  const edges: TopoFlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "smoothstep",
    // Every edge animates. This was once the SQS hop alone — the animation carrying the fact
    // that the call crosses a queue and another pod — and that reading is gone by decision, not
    // by accident: motion is now uniform, so it says the map is live rather than saying
    // anything about a particular edge.
    //
    // Which means the SQS edge's DISTINCTION now rests entirely on the things that did not
    // move: the accent stroke and the extra weight (styles.ts, .topo-edge-sqs), the accent
    // border on the backend card it reaches, and the legend row that names it. Do not drop any
    // of those three — before this change there were four signals and the animation was one of
    // them; there are three left and none is redundant.
    animated: true,
    className: e.kind === "sqs" ? "topo-edge topo-edge-sqs" : "topo-edge",
  }));

  return { nodes, edges };
}
