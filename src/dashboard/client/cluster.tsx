import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from "@xyflow/react";
// No stylesheet import: the page links topology.css, which already carries React Flow's own
// stylesheet and the shared Tailwind subset. A second stylesheet would be a second round trip.
import { buildClusterGraph, nsId } from "../cluster-graph.js";
import type { ClusterInventory } from "../cluster-types.js";
import { layoutClusterGraph } from "./cluster-layout.js";
import type { ClusterFlowNode } from "./cluster-layout.js";
import { clusterNodeTypes } from "./cluster-nodes.js";
import { markDragEnd } from "./drag-state.js";

const MOUNT_ID = "cluster-root";
const DATA_ID = "cluster-data";

function ClusterMap({ inv }: { inv: ClusterInventory }): React.JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showSystem, setShowSystem] = useState(false);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const laid = useMemo(() => {
    const out = layoutClusterGraph(buildClusterGraph(inv, expanded, showSystem));
    // The card toggles itself (a real <button>), so the callback rides in its data.
    for (const n of out.nodes) if (n.data.kind === "namespace") n.data = { ...n.data, onToggle: () => toggle(n.id) };
    return out;
  }, [inv, expanded, showSystem]);

  const [nodes, setNodes, onNodesChange] = useNodesState<ClusterFlowNode>(laid.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(laid.edges);
  const { fitView } = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    setNodes(laid.nodes);
    setEdges(laid.edges);
    if (first.current) {
      first.current = false;
      return;
    }
    const id = requestAnimationFrame(() => fitView({ padding: 0.06, duration: 400, maxZoom: 1 }));
    return () => cancelAnimationFrame(id);
  }, [laid, setNodes, setEdges, fitView]);

  const open = inv.namespaces.filter((n) => expanded.has(nsId(n.name)) && (showSystem || !n.system));
  const SWATCH = "w-[22px] h-3.5 rounded-[3px] shrink-0 border-[1.5px] bg-card";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 pb-2 text-sm text-muted-foreground">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
          Show system namespaces
        </label>
        {open.map((n) => (
          <button key={n.name} type="button" className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-2xs cursor-pointer hover:bg-muted" onClick={() => toggle(nsId(n.name))}>
            Collapse {n.name}
          </button>
        ))}
      </div>
      <div className="topo-view">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={markDragEnd}
          nodeTypes={clusterNodeTypes}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.06 }}
          minZoom={0.2}
          maxZoom={2.5}
          colorMode="system"
          zoomOnScroll={false}
          panOnScroll={false}
          zoomActivationKeyCode={["Meta", "Control"]}
          preventScrolling={false}
          aria-label="Cluster map"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="topo-bg" />
          <Controls showInteractive={false} className="topo-controls" />
        </ReactFlow>
      </div>
      <ul className="list-none m-0 px-4 pt-3 pb-4 border-t border-[var(--border)] flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <li className="flex items-center gap-2"><span className="inline-block w-6 border-t-2 border-[var(--text-dim)]" aria-hidden="true" />routes traffic</li>
        <li className="flex items-center gap-2"><span className="inline-block w-6 border-t-2 border-dashed border-[var(--text-dim)]" aria-hidden="true" />managed by</li>
        <li className="flex items-center gap-2"><span className={`${SWATCH} border-warning`} aria-hidden="true" />not managed by GitOps</li>
        <li className="ml-auto italic max-[46rem]:ml-0">
          <b>+</b> opens a namespace · Drag to move · Ctrl + scroll to zoom
        </li>
      </ul>
    </>
  );
}

/** Any failure leaves the page as the server sent it: a sentence, then the tables with every fact. */
function main(): void {
  const mount = document.getElementById(MOUNT_ID);
  const data = document.getElementById(DATA_ID);
  if (!mount || !data?.textContent) return;
  let inv: ClusterInventory;
  try {
    inv = JSON.parse(data.textContent) as ClusterInventory;
  } catch {
    return;
  }
  if (!Array.isArray(inv?.namespaces)) return;
  mount.textContent = "";
  mount.removeAttribute("data-fallback");
  createRoot(mount).render(
    <StrictMode>
      <ReactFlowProvider>
        <ClusterMap inv={inv} />
      </ReactFlowProvider>
    </StrictMode>
  );
}

main();
