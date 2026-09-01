import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TopoNodeData, TopoNodeKind } from "../topology-graph.js";
import type { TopoFlowNode } from "./layout.js";
import { justDragged } from "./drag-state.js";

// The class vocabulary is deliberately the one the SVG map already used — .topo-self,
// .topo-backend-worker, .topo-off and the rest. Not nostalgia: topoLegend() in views.ts states
// this vocabulary on the page and its swatches must use "the same classes AND the same
// element" as the drawing. That rule drifted once when the two were only nearly the same, so
// keeping the names means the legend needed one change (its swatches became divs) rather than
// a new parallel set of names that could disagree.
const KIND_CLASS: Record<TopoNodeKind, string> = {
  inbound: "topo-in",
  agent: "topo-self",
  outbound: "topo-out",
  backend: "topo-backend",
  capability: "topo-capability",
};

function classesFor(d: TopoNodeData): string {
  const out = ["topo-node", KIND_CLASS[d.kind]];
  // The stroke of the CHIP is what marks a worker-reached backend — not the edge, which is
  // grey. The legend's swatch carries the same two classes for the same reason.
  if (d.viaWorker) out.push("topo-backend-worker");
  if (!d.configured) out.push("topo-off");
  return out.join(" ");
}

/**
 * One component for all five kinds. They differ in class and in whether they carry a route
 * chip, not in structure — and a structure stated once cannot drift between the kind that is
 * five nodes and the kind that is one.
 */
export function TopoNodeCard({ data }: NodeProps<TopoFlowNode>): React.JSX.Element {
  const d = data;
  // The accessible name carries the UNTRUNCATED value: CSS clips the visible text to the card,
  // exactly as the SVG's clip() did, so this is the only place the full string survives for a
  // screen reader. Same reasoning as the old card()'s aria-label on the <a>.
  // The route rides in here because `aria-label` REPLACES the element's contents for assistive
  // tech: the chip below is visible text that a screen reader would otherwise never reach.
  const full = [d.title, d.sub, d.route].filter(Boolean).join(" — ");

  const body = (
    <>
      <span className="topo-node-title">{d.title}</span>
      {d.sub ? <span className="topo-node-sub">{d.sub}</span> : null}
      {/* heavy / light / unrouted. Only backends have one, and "unrouted" is worth seeing:
          it means the registry lists the backend but no chain will ever pick it. */}
      {d.route ? <span className="topo-node-route" data-route={d.route}>{d.route}</span> : null}
    </>
  );

  return (
    <div className={classesFor(d)} title={d.meta || undefined}>
      {/* Both handles on every node, and both hidden in CSS. React Flow needs a handle to
          anchor an edge; this map has no interactive connecting, so they carry no affordance.
          Left/right because the layout is rankdir LR — a handle on the wrong side routes the
          edge the long way around the card. */}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {d.href ? (
        <a
          className="topo-node-link"
          href={d.href}
          aria-label={full}
          // See drag-state.ts: without this, dragging a card to see behind it navigates.
          onClick={(e) => {
            if (justDragged()) e.preventDefault();
          }}
        >
          {body}
        </a>
      ) : (
        body
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

// Registered once, outside the component tree. React Flow re-creates its internal node cache
// whenever this object's identity changes, so building it inline in render would rebuild every
// node on every state change — including on every drag frame.
export const nodeTypes = { topo: TopoNodeCard };
