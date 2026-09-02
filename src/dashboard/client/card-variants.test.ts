import { test } from "node:test";
import assert from "node:assert/strict";
import { cardClass } from "./card-variants.js";
import type { TopoNodeKind } from "../topology-graph.js";

// The map's colour discipline, asserted rather than described. These used to be CSS rules in
// styles.ts with the reasoning in a comment above them; moving the cards to Tailwind + shadcn
// would have left that reasoning with nothing checking it, so it became this file.

const KINDS: TopoNodeKind[] = ["inbound", "agent", "outbound", "backend", "capability", "tool", "store"];

// One fill for the whole figure, so there is exactly one text-on-background pair and no group's
// colour can break legibility. An earlier revision coloured cards by role; it was pretty and it
// lied, because red means "critical" on every other page of this dashboard.
test("every card sits on the same fill", () => {
  for (const kind of KINDS) assert.match(cardClass({ kind }), /\bbg-card\b/, kind);
});

// `border-border` is aliased in tailwind.css to --mark-line (3.63:1), NOT --border (1.65:1):
// an edge is nothing but its stroke, and in the light scheme a card is nothing but its outline
// because --surface and --surface-raised are the same white. That alias is a decision, and this
// is what stops a card being restyled onto a hairline token.
test("structure comes off the mark ramp", () => {
  for (const kind of KINDS) {
    if (kind === "agent") continue; // the subject of the map: --foreground, stated below
    assert.match(cardClass({ kind }), /\bborder-border\b/, kind);
  }
});

// The subject of the map earns WEIGHT, not hue.
test("the agent is marked by weight, never by colour", () => {
  const c = cardClass({ kind: "agent" });
  assert.match(c, /\bborder-2\b/);
  assert.match(c, /\bborder-foreground\b/);
  assert.doesNotMatch(c, /border-primary|border-warning/);
});

// State never rests on colour alone — it has to survive greyscale, a printout, and a reader who
// cannot separate the hues. Amber AND dashed.
test("not-configured is dashed as well as amber", () => {
  const c = cardClass({ kind: "outbound", off: true });
  assert.match(c, /\bborder-warning\b/);
  assert.match(c, /\bborder-dashed\b/);
});

// The one fact this map exists to make obvious. Since every edge animates, the accent border on
// the card it reaches is one of only three signals left carrying it.
test("a worker-reached backend carries the accent border at extra weight", () => {
  const c = cardClass({ kind: "backend", viaWorker: true });
  assert.match(c, /\bborder-primary\b/);
  assert.match(c, /\bborder-2\b/);
});

// Colour is spent. The structural kinds get none of their own — a tool family especially, since
// the agent knows the server ADVERTISED it, not that calling it works, and any colour there
// would be a health claim this page cannot make.
test("the structural kinds carry no colour of their own", () => {
  for (const kind of ["inbound", "outbound", "backend", "capability", "tool", "store"] as TopoNodeKind[]) {
    const c = cardClass({ kind });
    assert.doesNotMatch(c, /border-warning|border-primary|border-foreground/, kind);
  }
});

// A tool is something another process said it exposes; a store is something this agent WRITES.
// The map says so in two borders, not only in two words.
test("a tool is dashed and a store is solid", () => {
  assert.match(cardClass({ kind: "tool" }), /\bborder-dashed\b/);
  assert.doesNotMatch(cardClass({ kind: "store" }), /\bborder-dashed\b/);
});

// twMerge resolving the conflict is what the legend's swatch depends on: it overrides SIZE and
// padding only, and every property it is actually explaining is inherited from the same
// composition the card uses. Without conflict resolution both widths would ship and source
// order would decide.
// PLAIN overrides, and that is not a style choice. The v3 `!w-[22px]` prefix is not generated
// by Tailwind v4 at all, and the v4 `w-[22px]!` suffix makes twMerge keep BOTH classes — both
// measured. Only the unmodified form gets the conflict resolved, which is what the legend needs.
test("a caller's override wins over the base, so the legend can resize a real card", () => {
  const c = cardClass({ kind: "agent", className: "w-[22px] h-3.5 p-0" });
  assert.match(c, /\bw-\[22px\]/);
  assert.doesNotMatch(c, /\bw-full\b/, "the base width must be dropped, not merely outranked");
  // ...and the thing being explained survives the resize.
  assert.match(c, /\bborder-foreground\b/);
});

// A clickable card that does nothing under the pointer reads as decoration. styles.ts had
// `.react-flow__node:hover .topo-node { background: --surface-2 }`; it went with the rest of the
// card CSS in the Tailwind move and nothing replaced it, so every card sat inert. Found by
// measuring the computed background before and after a hover, not by looking.
test("a card responds to the pointer", () => {
  const c = cardClass({ kind: "outbound" });
  assert.match(c, /hover:bg-muted/);
  assert.match(c, /transition-colors/, "and it has something to animate with");
});
