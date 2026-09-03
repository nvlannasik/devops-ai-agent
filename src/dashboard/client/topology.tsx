import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
// React Flow's own stylesheet. esbuild emits it as dist/public/topology.css, which the page
// links BEFORE its inline <style> block so the dashboard's rules win on equal specificity.
import "@xyflow/react/dist/style.css";
import { buildGraph } from "../topology-graph.js";
import type { TopoGraph } from "../topology-graph.js";
import type { Topology } from "../topology-types.js";
import { layoutGraph } from "./layout.js";
import type { TopoFlowNode } from "./layout.js";
import { nodeTypes } from "./nodes.js";
import { Legend } from "./legend.js";
import { justDragged, markDragEnd } from "./drag-state.js";

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

function TopoMap({ topology }: { topology: Topology }): React.JSX.Element {
  // Which tool families are open. The set is the ONLY state this component owns; the graph and
  // the layout are both derived from it, so there is no second place expansion can be recorded
  // and no way for the two to disagree.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Re-laid out on every change to that set, and this DOES discard a reader's drags. That is
  // the correct trade rather than a limitation worth working around: opening a family with 34
  // tools has to make room for them, and preserving hand-placed cards would either overlap the
  // new nodes or leave a hole where they should be. Collapsing restores the same layout the
  // map loaded with, which is the thing a reader who has lost their place actually wants.
  const graph: TopoGraph = useMemo(() => buildGraph(topology, expanded), [topology, expanded]);
  const laid = useMemo(() => layoutGraph(graph), [graph]);

  const [nodes, setNodes, onNodesChange] = useNodesState<TopoFlowNode>(laid.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(laid.edges);
  const { fitView } = useReactFlow();
  const first = useRef(true);

  useEffect(() => {
    setNodes(laid.nodes);
    setEdges(laid.edges);
    // Re-fit AFTER an expand or collapse, never on the first render — the <ReactFlow fitView>
    // prop already handles the mount, and running both fights over the viewport.
    //
    // This is not polish. Without it, opening k8s adds a block roughly 600x480 and the viewport
    // stays exactly where it was: the tools land off the right edge and the agent, Slack and
    // Alertmanager go off the left. Measured — the first build of this feature did precisely
    // that, and a reader who clicked "expand" lost the entire map.
    //
    // maxZoom 1 so a small family cannot magnify the map past its own type scale; the animation
    // is the viewport's, and it is what makes the expansion read as the map opening up rather
    // than as a different map being swapped in.
    if (first.current) {
      first.current = false;
      return;
    }
    const id = requestAnimationFrame(() => fitView({ padding: 0.06, duration: 400, maxZoom: 1 }));
    return () => cancelAnimationFrame(id);
  }, [laid, setNodes, setEdges, fitView]);

  // The toggle lives here rather than in the card, so no callback has to be stored in
  // serialized node data — React Flow re-creates its node cache whenever that object's
  // identity changes, and a function in it would change on every render.
  const onNodeClick = useCallback((_: unknown, node: TopoFlowNode) => {
    // Any card with children, not just a tool family: Postgres and Redis expand into what they
    // hold. `expanded` is set by buildGraph only where there is something to open.
    if (node.data.expanded === undefined) return;
    // The row link inside the card stops its own propagation, so reaching here means the
    // toggle (or the card around it) was clicked. A drag that ends on a card is not a click.
    if (justDragged()) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(node.id)) next.add(node.id);
      return next;
    });
  }, []);

  return (
    <>
      {/* The canvas is wrapped rather than mounted directly, because React Flow measures its
          own size from its container and the LEGEND is a sibling of that container, not of the
          map. It moved into React with the card styling — see legend.tsx for why that is what
          preserves the swatch rule rather than breaking it. */}
      <div className="topo-view">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={markDragEnd}
      onNodeClick={onNodeClick}
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
      fitViewOptions={{ padding: 0.06 }}
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
      <Controls showInteractive={false} className="topo-controls" />
    </ReactFlow>
      </div>
      <Legend graph={graph} />
    </>
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
      {/* useReactFlow() reads the store from context, and <ReactFlow> does not provide it to
          its own parent — so the provider has to sit above TopoMap rather than inside it. */}
      <ReactFlowProvider>
        <TopoMap topology={topology} />
      </ReactFlowProvider>
    </StrictMode>
  );
}

main();
