import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { TopoFlowNode } from "./layout.js";
import { justDragged } from "./drag-state.js";
import { Icon } from "./icons.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { cn } from "./lib/utils.js";
import { cardClass } from "./card-variants.js";

/**
 * One component for all seven kinds. They differ in variant, in whether they carry a badge, and
 * in what the click does — not in structure, and a structure stated once cannot drift between
 * the kind that is five nodes and the kind that is one.
 *
 * Three click behaviours, decided by the DATA and never by the caller: a card with children
 * toggles them (the parent's `onNodeClick` does the toggling — see topology.tsx — so no
 * callback has to live in serialized node data), a leaf does nothing because it has no row to
 * go to, and everything else follows its link.
 */
export function TopoNodeCard({ data }: NodeProps<TopoFlowNode>): React.JSX.Element {
  const d = data;
  // The accessible name carries the UNTRUNCATED value: CSS clips the visible text to the card,
  // so this is the only place the full string survives for a screen reader. The badges ride in
  // here for the same reason — `aria-label` REPLACES the element's contents for assistive tech,
  // so a badge that is not in it is a badge no AT user ever reaches.
  const full = [d.title, d.sub, d.route, d.write ? "can change the cluster" : ""]
    .filter(Boolean)
    .join(" — ");

  // Card anatomy: a glyph column beside a text column, which is what every SaaS card of this
  // shape does and what the absolute-positioned icon plus a pl-5 indent was imitating badly.
  // One row, so the icon aligns to the TITLE rather than floating above it, and `min-w-0` on
  // the text column is what lets `truncate` actually truncate inside a flex parent.
  const body = (
    <div className="flex w-full min-w-0 items-start gap-2">
      {d.icon ? <Icon name={d.icon} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "block truncate",
            d.kind === "tool"
              ? "font-mono text-2xs font-medium text-muted-foreground"
              : "text-sm font-medium text-foreground",
            d.kind === "store" && "font-mono text-2xs font-semibold text-foreground",
            !d.configured && "text-muted-foreground"
          )}
        >
          {d.title}
        </span>
        {d.sub ? (
          <span
            className={cn(
              "block truncate text-muted-foreground",
              d.kind === "store" ? "text-2xs" : "font-mono text-2xs"
            )}
          >
            {d.sub}
          </span>
        ) : null}
        {/* heavy / light / unrouted. Only backends have one, and "unrouted" is worth seeing: the
            registry lists the backend but no chain will ever pick it. */}
        {d.route ? (
          <Badge variant={d.route === "unrouted" ? "warning" : "muted"} className="self-start">
            {d.route}
          </Badge>
        ) : null}
      </div>
      {/* Outside the text column, so a long tool name truncates against it instead of pushing
          it off the card. */}
      {d.write ? <Badge variant="strong" className="mt-px">write</Badge> : null}
    </div>
  );

  return (
    <div
      className={cardClass({ kind: d.kind, off: !d.configured, viaWorker: !!d.viaWorker })}
      title={d.meta || undefined}
    >
      {/* Both handles on every node, and both hidden. React Flow needs one to anchor an edge;
          this map connects nothing, so they carry no affordance. Left/right because the layout
          is rankdir LR — a handle on the wrong side routes the edge around the card. */}
      <Handle type="target" position={Position.Left} isConnectable={false} />

      {d.expanded !== undefined ? (
        // A card with children has two things to offer, so it carries two controls rather than
        // one that has to guess. Siblings, not nested: a <button> inside an <a> is invalid, and
        // either nesting makes one unreachable by keyboard.
        //
        // Keyed on `expanded` being SET rather than on the kind: a capability always has tools,
        // but Postgres has tables only because stores.ts found the migrations, and a card that
        // rendered a disclosure over an empty list would be a control that does nothing.
        <>
          <Button
            size="fill"
            aria-expanded={!!d.expanded}
            aria-label={`${full} — ${d.expanded ? "hide" : "show"} what it holds`}
          >
            {body}
            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 grid size-5 place-items-center rounded-sm font-mono text-sm leading-none text-muted-foreground">
              {d.expanded ? "−" : "+"}
            </span>
          </Button>
          <Button
            asChild
            className="absolute right-1.5 bottom-0.5 hover:text-primary"
            aria-label={`Go to the ${d.title} row in the table below`}
          >
            <a
              href={d.href}
              // Without this the click reaches React Flow's onNodeClick too, and the card
              // toggles on its way to the row it was asked to open.
              onClick={(e) => {
                e.stopPropagation();
                if (justDragged()) e.preventDefault();
              }}
            >
              ↓
            </a>
          </Button>
        </>
      ) : d.href ? (
        <a
          className="flex flex-col justify-center gap-0.5 h-full min-w-0 no-underline text-inherit cursor-pointer"
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
        // The agent (it IS what the tables are about) and every leaf (the tables list a tool
        // inside its family's <details>, which has no id). Neither has a row to go to.
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
