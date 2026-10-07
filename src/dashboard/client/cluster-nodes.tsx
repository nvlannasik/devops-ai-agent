import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ClusterFlowNode } from "./cluster-layout.js";
import { justDragged } from "./drag-state.js";
import { cn } from "./lib/utils.js";

const KIND_CAPTION: Record<string, string> = {
  namespace: "namespace",
  host: "ingress host",
  service: "service",
  workload: "workload",
  owner: "managed by",
};

/**
 * One card for every kind. A namespace card is a real <button> — Enter and Space and focus come
 * with it — and toggles through `onToggle`, which cluster.tsx puts in its data. A card that only
 * reports (host, Service, workload, owner) is not a control and does not pretend to be one.
 */
export function ClusterNodeCard({ data: d }: NodeProps<ClusterFlowNode>): React.JSX.Element {
  const full = [KIND_CAPTION[d.kind], d.label, d.sub].filter(Boolean).join(" — ");
  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span className="text-2xs uppercase tracking-wide text-muted-foreground">{KIND_CAPTION[d.kind]}</span>
      <span className={cn("block truncate font-mono text-sm font-medium text-foreground", d.tone === "warning" && "text-[var(--warning)]")}>
        {d.label}
      </span>
      {d.sub ? <span className="block truncate font-mono text-2xs text-muted-foreground">{d.sub}</span> : null}
    </div>
  );
  const onToggle = d.onToggle as (() => void) | undefined;
  return (
    <div
      className={cn(
        "box-border flex h-full w-full overflow-hidden rounded-lg border-[1.5px] border-border bg-card px-3 py-1.5 shadow-[var(--shadow-sm)]",
        d.kind === "namespace" && "border-2 hover:bg-muted",
        d.kind === "owner" && "border-dashed",
        d.tone === "warning" && "border-warning"
      )}
      title={full}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {d.kind === "namespace" && onToggle ? (
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 bg-transparent border-0 p-0 font-[inherit] cursor-pointer"
          aria-expanded={false}
          aria-label={`${full} — show what it holds`}
          onClick={(e) => {
            e.stopPropagation();
            if (!justDragged()) onToggle();
          }}
        >
          {body}
          <span className="font-mono text-sm text-muted-foreground" aria-hidden="true">+</span>
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-center" aria-label={full}>
          {body}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

// Registered once, outside the tree — see nodes.tsx: a new object identity rebuilds every node.
export const clusterNodeTypes = { cluster: ClusterNodeCard };
