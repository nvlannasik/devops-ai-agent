import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Box, FolderTree, GitBranch, Globe, Network, TriangleAlert, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ClusterFlowNode } from "./cluster-layout.js";
import { justDragged } from "./drag-state.js";
import { cn } from "./lib/utils.js";

/**
 * One glyph and one accent per kind, so a card says what it is before its caption is read
 * (feedback 2026-10-08: every card looked the same). The accent is the MARK ramp — a left bar, a
 * non-text graphic, 3:1 — and colour is never the only signal: the glyph and the caption say it too.
 * Managed-by-GitOps is ok-green and not-managed is warning-amber, because that IS the judgement
 * this page asks a newcomer to make.
 */
const KIND: Record<string, { caption: string; icon: LucideIcon; accent: string }> = {
  namespace: { caption: "namespace", icon: FolderTree, accent: "var(--accent)" },
  host: { caption: "ingress host", icon: Globe, accent: "var(--mark-info)" },
  service: { caption: "service", icon: Network, accent: "var(--accent)" },
  workload: { caption: "workload", icon: Box, accent: "var(--mark-line)" },
  owner: { caption: "managed by", icon: GitBranch, accent: "var(--mark-ok)" },
};

const Glyph = ({ icon: I, color }: { icon: LucideIcon; color: string }) => (
  <span className="grid size-[1.625rem] shrink-0 place-items-center rounded-[var(--r-sm)] bg-[var(--brand-tint)]" style={{ color }}>
    <I size={14} strokeWidth={1.6} absoluteStrokeWidth aria-hidden="true" />
  </span>
);

/** The frame of an open namespace — a surface behind its cards and edges, taking no pointer. */
const Frame = () => (
  <div className="pointer-events-none h-full w-full rounded-xl border-2 border-[var(--accent)] bg-[var(--surface-2,var(--surface))]" aria-hidden="true" />
);

/** The panel's header: its name, what it holds, a close control, and the lane headings. */
function PanelHead({ d }: { d: ClusterFlowNode["data"] }): React.JSX.Element {
  const onToggle = d.onToggle as (() => void) | undefined;
  const columns = (d.columns as Array<{ label: string; x: number }>) ?? [];
  return (
    <div className="relative h-full w-full" aria-label={`namespace ${d.label}, open`}>
      <div className="flex items-center gap-2 px-4 pt-2.5">
        <Glyph icon={FolderTree} color="var(--accent)" />
        <span className="font-mono text-sm font-semibold text-foreground">{d.label}</span>
        <span className="text-2xs text-muted-foreground">{d.sub}</span>
        {onToggle ? (
          <button
            type="button"
            className="ml-auto grid size-7 place-items-center rounded-md border border-border bg-card text-muted-foreground cursor-pointer hover:bg-muted"
            aria-label={`Close ${d.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {columns.map((c) => (
        <span key={c.label} className="absolute top-[2.75rem] text-2xs font-semibold uppercase tracking-wide text-muted-foreground" style={{ left: c.x }}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

/**
 * One card for every kind. A namespace card is a real <button> — Enter, Space and focus come with
 * it — and toggles through `onToggle`, which cluster.tsx puts in its data; an open one stays in the
 * grid, marked, so a reader can see which namespace the panel below belongs to.
 */
export function ClusterNodeCard({ data: d }: NodeProps<ClusterFlowNode>): React.JSX.Element {
  if (d.kind === "panel") return <Frame />;
  if (d.kind === "panelHead") return <PanelHead d={d} />;
  const kind = KIND[d.kind]!;
  const warn = d.tone === "warning";
  const accent = warn ? "var(--mark-warning)" : kind.accent;
  const open = d.kind === "namespace" && d.expanded === true;
  const full = [kind.caption, d.label, d.sub].filter(Boolean).join(" — ");
  const body = (
    <div className="flex w-full min-w-0 items-center gap-2 text-left">
      <Glyph icon={warn ? TriangleAlert : kind.icon} color={accent} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">{kind.caption}</span>
        <span className={cn("block truncate font-mono text-sm font-medium text-foreground", warn && "text-[var(--warning)]")}>{d.label}</span>
        {d.sub ? <span className="block truncate font-mono text-2xs text-muted-foreground">{d.sub}</span> : null}
      </div>
    </div>
  );
  const onToggle = d.onToggle as (() => void) | undefined;
  return (
    <div
      className={cn(
        "box-border flex h-full w-full overflow-hidden rounded-lg border border-border bg-card py-1.5 pl-2.5 pr-2 shadow-[var(--shadow-sm)]",
        d.kind === "namespace" && "hover:bg-muted",
        open && "border-2 border-[var(--accent)] bg-[var(--brand-tint)]",
        d.kind === "owner" && !warn && "border-dashed",
        warn && "border-warning"
      )}
      // The accent bar: one stripe, the kind's colour. Inline because it is per-node data, and the
      // page's CSP allows inline style (style-src 'unsafe-inline', no script).
      style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
      title={full}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {d.kind === "namespace" && onToggle ? (
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 bg-transparent border-0 p-0 font-[inherit] cursor-pointer"
          aria-expanded={open}
          aria-label={`${full} — ${open ? "close" : "show what it holds"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!justDragged()) onToggle();
          }}
        >
          {body}
          <span className="font-mono text-base text-muted-foreground" aria-hidden="true">{open ? "−" : "+"}</span>
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
