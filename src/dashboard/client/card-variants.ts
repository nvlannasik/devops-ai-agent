import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "./lib/utils.js";

// Split out of nodes.tsx for the same reason topology-graph.ts is split out of the client: what
// a card LOOKS like encodes claims this project has already paid to learn — which contrast ramp
// a structural border comes off, that state never rests on colour alone — and a claim belongs
// where `npm test` can reach it. A .tsx importing React and @xyflow/react is typechecked but
// never executed by node:test; this file is plain TypeScript and runs headless.
//
// The map's cards, written in shadcn's idiom: one `cva` holding every variant a card can be,
// rather than the hand-concatenated class list this replaced. The win is not the syntax — it
// is that KIND and STATE are separate axes here, so "a not-configured outbound card" is one
// composition rather than a case someone has to remember to handle.
//
// The colour discipline is unchanged and is the thing to preserve if these are ever edited.
// Every card sits on the same fill, so there is exactly one text-on-background pair in the
// figure and no group's colour can break legibility. Role is carried by POSITION — dagre ranks
// the columns from the edges — which leaves the border free for the only two things here that
// are actually STATE:
//   warning  not configured                                3.85 light / 5.79 dark
//   accent   reached over SQS via llm-worker               6.17 / 8.49
// Structure is `border-border`, which `tailwind.css` aliases to --mark-line (3.63) and NOT to
// --border (1.65) — see the note there, that alias is a decision rather than a mapping.
export const nodeCard = cva(
  "box-border w-full h-full flex overflow-hidden bg-card border-border shadow-[var(--shadow-sm)] transition-colors hover:bg-muted",
  {
    variants: {
      kind: {
        // The three structural boxes: a title over a caption, centred in the box.
        inbound: "flex-col justify-center gap-0.5 px-3 py-2 rounded-lg border-[1.5px]",
        outbound: "flex-col justify-center gap-0.5 px-3 py-2 rounded-lg border-[1.5px]",
        // The subject of the map. Weight, never hue.
        agent: "flex-col justify-center gap-0.5 px-3 py-2 rounded-lg border-2 border-foreground",
        backend: "flex-col justify-center gap-0.5 px-3 py-2 rounded-lg border-[1.5px]",
        capability: "flex-col justify-center gap-0.5 px-3 py-2 rounded-lg border-[1.5px]",
        // A tool is one identifier: a row, not a stack. Dashed because it is something another
        // process said it exposes, not something this agent declared.
        tool: "flex-row items-center gap-2 px-2 rounded-md border border-dashed",
        // A store is two lines and the second is a phrase, so it is the widest leaf. Solid,
        // because it is something this agent WRITES.
        store: "flex-col justify-center gap-px px-3 rounded-md border",
      },
      // State, and never colour alone: dashed as well as amber, so the mark survives being
      // printed, screenshotted in greyscale, or read by someone who cannot separate the hues.
      off: { true: "border-warning border-dashed" },
      viaWorker: { true: "border-2 border-primary" },
    },
    defaultVariants: { kind: "outbound" },
  }
);

type CardVariants = VariantProps<typeof nodeCard>;

/** The class list for one card. Exported so the legend's swatches are the SAME composition and
 *  not a copy of it — see `legend.tsx`, and the rule that has drifted once already.
 *
 *  `className` is split out before it reaches cva: cva has its own `class`/`className` prop for
 *  appending, and passing both shapes at once is a type error rather than a merge. Routing it
 *  through `cn` instead means a caller's override still wins the twMerge conflict resolution,
 *  which is exactly what the legend's swatch sizing depends on. */
export function cardClass({ className, ...v }: CardVariants & { className?: string }): string {
  return cn(nodeCard(v), className);
}
