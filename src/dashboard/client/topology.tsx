import { StrictMode, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { Node } from "@xyflow/react";
// React Flow's own stylesheet. esbuild emits it as dist/public/topology.css, which the page
// links BEFORE its inline <style> block so the dashboard's rules win on equal specificity.
import "@xyflow/react/dist/style.css";
import { buildGraph } from "../topology-graph.js";
import type { TopoGraph, TopoNodeData } from "../topology-graph.js";
import type { Topology } from "../topology-types.js";
import { layoutGraph } from "./layout.js";
import type { TopoFlowNode } from "./layout.js";
import { nodeTypes } from "./nodes.js";
import { markDragEnd } from "./drag-state.js";

// The interactive dependency map. The server renders the mount point and the topology as a
// JSON data block; everything visible here is built in the browser.
//
// The data arrives as <script type="application/json">, NOT as a nonce'd executable block that
// assigns a global. A data block is inert by definition — the browser does not execute it and
// CSP's script-src does not gate it — so the page keeps the property the whole dashboard is
// built around: a missed esc() upstream cannot become script execution. JSON.parse is the only
// thing that ever reads it, and JSON.parse cannot run code.

const MOUNT_ID = "topo-root";
const DATA_ID = "topo-data";

// MiniMap needs a colour per node and cannot read a CSS class, so this is the one place the
// palette is restated in JS. Kept to the four marks the legend already names; anything not
// listed falls through to the structural line colour, which is what an unclassified box would
// have been drawn in anyway.
const MINIMAP_VAR: Record<string, string> = {
  agent: "--text",
  backendWorker: "--accent",
  off: "--warning",
};

function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function TopoMap({ graph }: { graph: TopoGraph }): React.JSX.Element {
  // Laid out once. useNodesState then owns the positions, so a drag survives every re-render —
  // recomputing the layout on render would snap a dragged card back the moment anything else
  // in the tree changed.
  const initial = useMemo(() => layoutGraph(graph), [graph]);
  const [nodes, , onNodesChange] = useNodesState<TopoFlowNode>(initial.nodes);
  const [edges, , onEdgesChange] = useEdgesState(initial.edges);

  const minimapColor = useCallback((n: Node): string => {
    const d = n.data as TopoNodeData;
    if (!d.configured) return readVar(MINIMAP_VAR.off!);
    if (d.viaWorker) return readVar(MINIMAP_VAR.backendWorker!);
    if (d.kind === "agent") return readVar(MINIMAP_VAR.agent!);
    return readVar("--mark-line");
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={markDragEnd}
      nodeTypes={nodeTypes}
      // Read-only map: nothing here connects, deletes or re-wires. Every one of these is a
      // capability React Flow ships ON by default, and this dashboard is read-only by contract
      // (server.ts answers 405 to a POST anywhere but the two session routes) — a map that
      // let you delete a node would be the only place that stopped being true, even if the
      // deletion never left the browser.
      nodesConnectable={false}
      nodesDraggable
      elementsSelectable
      deleteKeyCode={null}
      // fitView on mount, with room around the drawing so the outermost cards are not flush
      // against the frame. minZoom below 1 because a 20-backend registry lays out wider than
      // any frame this page gets.
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      maxZoom={2.5}
      // The dashboard follows prefers-color-scheme and states no toggle; "system" is React
      // Flow reading the same signal rather than a second source of truth about the scheme.
      colorMode="system"
      // A trackpad two-finger scroll pans the PAGE by default and the map only on ctrl/cmd —
      // matching what the old script did, and the reason it did it: a map that swallows the
      // scroll wheel traps a reader who is only trying to get to the tables below it.
      zoomOnScroll={false}
      panOnScroll={false}
      // BOTH keys, because the legend promises "Ctrl + scroll" and React Flow's default for
      // this prop is "Meta" alone — which is Cmd on a Mac and nothing at all on Linux or
      // Windows, where this dashboard is mostly read. The inline script this replaced tested
      // `e.ctrlKey || e.metaKey` for the same reason.
      zoomActivationKeyCode={["Meta", "Control"]}
      preventScrolling={false}
      aria-label="Dependency map"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="topo-bg" />
      <MiniMap
        pannable
        zoomable
        nodeColor={minimapColor}
        className="topo-minimap"
        ariaLabel="Dependency map overview"
      />
      <Controls showInteractive={false} className="topo-controls" />
    </ReactFlow>
  );
}

/**
 * Reads the server's data block and mounts. Every failure path leaves the page exactly as the
 * server sent it — which is a short explanation plus the four tables, all of which carry the
 * same facts the map draws. A half-mounted map would be worse than none: the tables are the
 * record, and the map has always been the glance at them.
 */
function main(): void {
  const mount = document.getElementById(MOUNT_ID);
  const data = document.getElementById(DATA_ID);
  if (!mount || !data?.textContent) return;

  let topology: Topology;
  try {
    topology = JSON.parse(data.textContent) as Topology;
  } catch {
    return;
  }

  mount.textContent = "";
  mount.removeAttribute("data-fallback");
  createRoot(mount).render(
    <StrictMode>
      <TopoMap graph={buildGraph(topology)} />
    </StrictMode>
  );
}

main();
