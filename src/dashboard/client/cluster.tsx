import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesInitialized, useNodesState, useReactFlow } from "@xyflow/react";
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
  // Four cards a row on a desktop frame, two on a phone: one column of 17 opened at 0.47 on the
  // live cluster, four on a 390px frame at 0.30. Read once — the frame does not change width.
  const [cols] = useState(() => ((document.getElementById(MOUNT_ID)?.clientWidth ?? 1000) < 640 ? 2 : 4));

  const laid = useMemo(() => {
    const out = layoutClusterGraph(buildClusterGraph(inv, expanded, showSystem), cols);
    // The card toggles itself (a real <button>), so the callback rides in its data.
    for (const n of out.nodes) {
      if (n.data.kind === "namespace") n.data = { ...n.data, onToggle: () => toggle(n.id) };
      // The panel's ✕ closes the namespace it frames — the same toggle as its grid card.
      if (n.data.kind === "panelHead") n.data = { ...n.data, onToggle: () => toggle(nsId(n.data.namespace)) };
    }
    return out;
  }, [inv, expanded, showSystem, cols]);

  const [nodes, setNodes, onNodesChange] = useNodesState<ClusterFlowNode>(laid.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(laid.edges);
  const { fitView } = useReactFlow();
  const first = useRef(true);
  const pendingFit = useRef(false);
  const initialized = useNodesInitialized();
  useEffect(() => {
    setNodes(laid.nodes);
    setEdges(laid.edges);
    if (first.current) first.current = false;
    else pendingFit.current = true;
  }, [laid, setNodes, setEdges]);
  // Fit only once the NEW cards are measured. Fitting on the next frame (as /topology does) ran
  // before React Flow had sized the cards an expand added, so the fit used the old bounds:
  // measured on the live cluster, 2026-10-08, a collapse kept the expanded zoom and a phone's
  // view never moved.
  useEffect(() => {
    if (!initialized || !pendingFit.current) return;
    pendingFit.current = false;
    void fitView({ padding: 0.06, duration: 400, maxZoom: 1 });
  }, [initialized, nodes, fitView]);

  const SWATCH = "w-[22px] h-3.5 rounded-[3px] shrink-0 border-[1.5px] bg-card";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 pb-2 text-sm text-muted-foreground">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
          Show system namespaces
        </label>
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
        <li className="flex items-center gap-2"><span className={SWATCH} style={{ boxShadow: "inset 3px 0 0 var(--mark-info)" }} aria-hidden="true" />ingress host</li>
        <li className="flex items-center gap-2"><span className={SWATCH} style={{ boxShadow: "inset 3px 0 0 var(--accent)" }} aria-hidden="true" />service</li>
        <li className="flex items-center gap-2"><span className={SWATCH} style={{ boxShadow: "inset 3px 0 0 var(--mark-line)" }} aria-hidden="true" />workload</li>
        <li className="flex items-center gap-2"><span className={`${SWATCH} border-dashed`} style={{ boxShadow: "inset 3px 0 0 var(--mark-ok)" }} aria-hidden="true" />managed by GitOps</li>
        <li className="flex items-center gap-2"><span className={`${SWATCH} border-warning`} style={{ boxShadow: "inset 3px 0 0 var(--mark-warning)" }} aria-hidden="true" />not managed by GitOps</li>
        <li className="ml-auto italic max-[46rem]:ml-0">
          <b>+</b> opens a namespace, <b>✕</b> or <b>−</b> closes it · Ctrl + scroll to zoom
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
