import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesInitialized, useNodesState, useReactFlow } from "@xyflow/react";
// No stylesheet import: the page links topology.css, which already carries React Flow's own
// stylesheet and the shared Tailwind subset. A second stylesheet would be a second round trip.
import { buildClusterGraph, nsId } from "../cluster-graph.js";
import type { ClusterInventory, DashboardClusterModel, DashboardGitKey } from "../cluster-types.js";
import { layoutClusterGraph } from "./cluster-layout.js";
import type { ClusterFlowNode } from "./cluster-layout.js";
import { clusterNodeTypes } from "./cluster-nodes.js";
import { markDragEnd } from "./drag-state.js";

const MOUNT_ID = "cluster-root";
const DATA_ID = "cluster-data";
const MODEL_ID = "cluster-model";

function ClusterMap({ inv, model }: { inv: ClusterInventory; model: DashboardClusterModel | null }): React.JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showSystem, setShowSystem] = useState(false);
  const [showTelemetry, setShowTelemetry] = useState(false);
  // The workload whose where-to-change panel is open (a model node id), or none.
  const [selected, setSelected] = useState<string | null>(null);
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
    const out = layoutClusterGraph(buildClusterGraph(inv, expanded, showSystem, model, showTelemetry), cols);
    // The card toggles itself (a real <button>), so the callback rides in its data.
    for (const n of out.nodes) {
      if (n.data.kind === "namespace") n.data = { ...n.data, onToggle: () => toggle(n.id) };
      // The panel's ✕ closes the namespace it frames — the same toggle as its grid card.
      if (n.data.kind === "panelHead") n.data = { ...n.data, onToggle: () => toggle(nsId(n.data.namespace)) };
    }
    return out;
  }, [inv, model, expanded, showSystem, showTelemetry, cols]);

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
        {model ? (
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={showTelemetry} onChange={(e) => setShowTelemetry(e.target.checked)} />
            Show telemetry
          </label>
        ) : null}
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
          onNodeClick={(_, n) => { if (n.data.kind === "workload") setSelected(n.id); }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="topo-bg" />
          <Controls showInteractive={false} className="topo-controls" />
        </ReactFlow>
      </div>
      {selected && model ? <WherePanel model={model} id={selected} onClose={() => setSelected(null)} /> : null}
      <ul className="list-none m-0 px-4 pt-3 pb-4 border-t border-[var(--border)] flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <li className="flex items-center gap-2"><span className="inline-block w-6 border-t-2 border-[var(--text-dim)]" aria-hidden="true" />routes traffic</li>
        <li className="flex items-center gap-2"><span className="inline-block w-6 border-t-2 border-dashed border-[var(--text-dim)]" aria-hidden="true" />managed by</li>
        {model ? (
          <>
            <li className="flex items-center gap-2"><span className="inline-block w-6 border-t-2 border-[var(--text-dim)]" aria-hidden="true" />▸ calls (observed)</li>
            <li className="flex items-center gap-2"><span className="inline-block w-6 border-t-2 border-dotted border-[var(--text-dim)]" aria-hidden="true" />configured dependency</li>
          </>
        ) : null}
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

function KeyRow({ what, k }: { what: string; k: DashboardGitKey | undefined }): React.JSX.Element {
  if (!k) return <li>{what}: not located in Git</li>;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span>{what}:</span>
      <code translate="no">{`${k.path}:${k.line}`}</code>
      <code translate="no">{k.key}</code>
      <span>= <code translate="no">{k.gitValue}</code></span>
      {k.drift ? <span className="font-semibold uppercase text-[var(--warning)]">drift — the cluster runs something else</span> : null}
    </li>
  );
}

/** Where to change a workload: the Git file, line and key for its image and replicas (agent/onboarding). */
function WherePanel({ model, id, onClose }: { model: DashboardClusterModel; id: string; onClose: () => void }): React.JSX.Element {
  const node = model.nodes.find((n) => n.id === id);
  const keys = model.changeAt[id];
  const name = node && node.kind !== "host" ? `${node.namespace}/${node.name}` : id;
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), [id]);
  return (
    <aside aria-label={`Where to change ${name}`} className="mx-4 mt-3 rounded-[var(--r)] border border-[var(--border)] bg-card p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <h3 className="m-0 text-base font-semibold"><code translate="no">{name}</code> — where to change it</h3>
        <button ref={close} type="button" aria-label="Close" onClick={onClose}
          className="cursor-pointer rounded-[var(--r-sm)] border border-[var(--border)] bg-transparent px-2 py-1 font-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">✕</button>
      </div>
      {keys ? (
        <ul className="m-0 mt-2 list-none space-y-1 p-0 [overflow-wrap:anywhere]">
          <KeyRow what="image" k={keys.image} />
          <KeyRow what="replicas" k={keys.replicas} />
        </ul>
      ) : (
        <p className="m-0 mt-2 text-muted-foreground">Not located in Git — see the notes under the map.</p>
      )}
      <p className="m-0 mt-2 text-muted-foreground">
        Flux applied <code translate="no">{model.snapshot.appliedRevision ?? "unknown"}</code> · repo{" "}
        <code translate="no">{model.snapshot.repoRevision?.slice(0, 7) ?? "unknown"}</code>
      </p>
    </aside>
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
  // The cluster model is optional: absent (cold cache) or unreadable is the inventory map alone.
  let model: DashboardClusterModel | null = null;
  try {
    const raw = document.getElementById(MODEL_ID)?.textContent;
    const parsed = raw ? (JSON.parse(raw) as DashboardClusterModel) : null;
    model = parsed && Array.isArray(parsed.edges) && Array.isArray(parsed.nodes) ? parsed : null;
  } catch {
    model = null;
  }
  mount.textContent = "";
  mount.removeAttribute("data-fallback");
  createRoot(mount).render(
    <StrictMode>
      <ReactFlowProvider>
        <ClusterMap inv={inv} model={model} />
      </ReactFlowProvider>
    </StrictMode>
  );
}

main();
