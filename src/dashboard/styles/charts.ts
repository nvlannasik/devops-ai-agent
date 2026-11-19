// Part of STYLES (../styles.ts): charts, the share bar, the donut, the topology map and hover. A template literal — read the rules in styles.ts first.
export const CHARTS_CSS = `
/* ---------- charts ---------- */
/* An SVG line over an HTML grid. The SVG holds the line and NOTHING else; every piece of text —
   the per-period value, the axis labels, the caption — is HTML at the page's own sizes. That
   split is the whole point. The chart was once a plain <svg viewBox="0 0 720 168"> with its type
   inside it, and a viewBox fixes the drawing's aspect ratio at authoring time AND scales the type
   with it, so one file had to serve a 900px hero and a 340px phone with the same shape: a
   letterbox strip at one end, 4px axis labels at the other. Here the plot's height is a clamp,
   the type is type, and both answer to the width of the chart's own frame. */
.chart { margin: 0; display: flex; flex-direction: column; gap: var(--sp-3); container: chart / inline-size; }
/* The columns come from --n on the figure, so the plot and the axis below it are two grids with
   identical tracks — every tick stays under its own point without either knowing the count.
   The dashed hairline at half scale is a background gradient rather than an element: it is a
   reading aid for the line, and an empty <div> in the DOM would be a reading aid for nobody.

   NO column gap here, unlike the axis below. The markup puts each vertex at the centre of its
   column as a percentage of the PLOT; a gap is a clamp in px, which shifts every track centre by
   an amount no server-rendered percentage can know, and the dots would drift off their own line.
   The axis keeps its gap because a label only has to sit under its column, not on a curve.

   padding-top leaves room for the value labels to sit above the topmost dot without the line
   being pushed down; the SVG is absolutely positioned inside that padding box, so it and the dots
   share one coordinate space. */
.chart-plot {
  position: relative;
  display: grid; grid-template-columns: repeat(var(--n, 12), minmax(0, 1fr));
  height: clamp(7rem, 30cqi, 14rem);
  padding-top: 1.15rem;
  border-bottom: 1px solid var(--border);
  background-image: repeating-linear-gradient(to right, var(--border) 0 2px, transparent 2px 6px);
  background-size: 100% 1px; background-position: 0 50%; background-repeat: no-repeat;
}
/* The unit-square viewBox is stretched to the plot with preserveAspectRatio="none" — that is what
   frees the height from the ratio. The stretch is non-uniform, so a plain stroke-width would come
   out as a wedge: thin where the box is wide, thick where it is tall, and different on every
   screen. vector-effect draws the stroke in device pixels AFTER the transform, so 2px is 2px. */
/* width/height 100% of the inset box, NOT auto. An SVG with a viewBox has an intrinsic aspect
   ratio, and height:auto hands the sizing back to it — the unit-square viewBox then draws itself
   square and the line detaches from the dots by however far the plot is from square (measured:
   407px adrift at 768). The four insets already state the box; these two make the drawing take it.
   The height is stated against the containing block rather than left to bottom:0 for the same
   reason: a percentage is resolved, an auto is negotiated with the intrinsic ratio and loses. */
.chart-line {
  position: absolute; inset: 1.15rem 0 0;
  width: 100%; height: calc(100% - 1.15rem);
}
.chart-stroke {
  fill: none; stroke: var(--accent); stroke-width: 2;
  stroke-linejoin: round; stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
/* The fill under the line is atmosphere, not a second reading of the data — the line already
   carries the value. Kept faint enough that the dashed half-scale rule stays visible through it,
   because that rule is what makes a height readable as a quantity. */
.chart-area { fill: var(--accent); opacity: .09; stroke: none; }
/* Each column is a full-height positioning context for one dot and its label. The dot is placed
   from the BOTTOM at the same --h the polyline used for its vertex, so the two agree by
   construction rather than by arithmetic done twice. */
.chart-col { position: relative; min-width: 0; height: 100%; }
/* Half the dot's size pulled back on the two edges it is positioned FROM — bottom and left — so
   its centre lands on --h rather than its edge. margin-top would do nothing here: an element
   offset from the bottom edge is placed by the bottom of its margin box, so a negative top margin
   is simply unused and the whole dot floats half its height above the line (measured: 4.5px). */
.chart-dot {
  position: absolute; bottom: var(--h, 0%); left: 50%;
  width: 7px; height: 7px; margin: 0 0 -3.5px -3.5px;
  border-radius: 50%; background: var(--accent);
}
/* The last point is the week in progress. Marking it is information, not decoration: without it
   the final vertex always reads as a collapse in incident volume. A ring rather than a disc —
   a hollow mark is the shape of a count still being filled in, and it needs no second colour. */
.chart-col[data-current] .chart-dot {
  background: var(--surface); border: 2px solid var(--accent);
  width: 9px; height: 9px; margin: 0 0 -4.5px -4.5px;
}
.chart-value {
  position: absolute; bottom: var(--h, 0%); left: 50%; transform: translateX(-50%);
  margin-bottom: .5rem; line-height: 1;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  color: var(--text-dim);
}
.chart-axis {
  display: grid; grid-template-columns: repeat(var(--n, 12), minmax(0, 1fr));
  gap: clamp(2px, 1.4cqi, 10px);
}
.chart-tick {
  font-family: var(--font-data); font-size: var(--fs-2xs); color: var(--text-dim);
  text-align: center; line-height: 1.2; white-space: nowrap;
  overflow: hidden; text-overflow: clip;
}
.chart-caption { font-family: var(--font-data); font-size: var(--fs-2xs); color: var(--text-dim); }
/* Same height as a populated plot, so a dashboard that has just come up does not reflow the
   moment its first incident lands. */
.chart-blank {
  grid-template-columns: minmax(0, 1fr); place-items: center; padding-top: 0;
  background-image: none; border-bottom-style: dashed;
  margin: 0; color: var(--text-dim); font-size: var(--fs-sm);
}
/* Thinning, in the order the reader can afford to lose things. The per-point counts go first —
   every one of them is in the tables below and each column keeps its title= — which is what buys
   the period labels room to stay legible. Then every second period label is hidden, counted
   from the newest backwards in the markup so the week in progress is never the one that goes.
   visibility, not display: the tick keeps its grid track, so the labels that remain stay
   directly under their own bars instead of redistributing across the axis. */
@container chart (max-width: 34rem) { .chart-value { display: none; } }
@container chart (max-width: 26rem) {
  .chart-tick[data-thin] { visibility: hidden; }
  /* Every surviving label now has a hidden neighbour on each side, so it may spill into that
     room. Without this it clips to its own track — half the width of a date — and a phone shows
     an axis reading 05-1 06-0 06-2, which is worse than showing no axis at all. */
  .chart-tick { overflow: visible; }
}
/* A dense series (chart.ts, DENSE_AFTER) has more periods than even a full-width axis can name:
   every second label goes at every width, and at the narrow step only every fourth survives. */
.chart-axis[data-dense] .chart-tick[data-thin] { visibility: hidden; }
.chart-axis[data-dense] .chart-tick { overflow: visible; }
@container chart (max-width: 26rem) { .chart-axis[data-dense] .chart-tick[data-thin4] { visibility: hidden; } }

/* ---------- share bar ---------- */
/* Parts of a whole as one horizontal bar with its legend under it. It replaced a ring: a ring
   wants a square, and the panel it lives in now is a third of the row — at that width the ring
   was 110px across with its legend squeezed beside it, where a bar spends the whole width on
   the one thing being compared, which is length.
   Each segment grows by its own value (--w, set inline), so the proportions are the browser's
   arithmetic and the markup carries no percentages. The 3px floor is what keeps a single
   critical incident among two hundred from rounding to nothing: a part that exists is drawn.
   The colour comes from the same [data-tone] vocabulary the badges and spines use; a part with
   no tone (token input against output) marks one segment data-lead and that one takes the
   accent, the other the neutral. The legend repeats every value as text — the bar is never the
   only place a number is. */
.share { margin: 0; display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.share-bar {
  display: flex; gap: 2px; height: .625rem;
  border-radius: var(--r-pill); overflow: hidden; background: var(--surface-2);
}
.share-bar > span {
  flex-grow: var(--w, 0); flex-basis: 0; min-width: 3px;
  background: var(--spine, var(--border-strong));
}
.share-bar > span[data-lead] { background: var(--accent); }
.share-legend {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm);
}
/* The whole row is the target where a part links somewhere, and its padding is pulled back out
   with a negative margin so the swatches still line up under the bar's left edge. */
.share-legend li > a, .share-item {
  display: inline-flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2); margin-left: calc(var(--sp-2) * -1);
  border-radius: var(--r-sm);
}
.share-legend li > a { color: inherit; text-decoration: none; }
.share-swatch {
  width: .625rem; height: .625rem; border-radius: 3px; flex: 0 0 auto;
  background: var(--spine, var(--border-strong));
}
li[data-lead] .share-swatch { background: var(--accent); }
.share-n {
  font-family: var(--font-data); font-variant-numeric: tabular-nums; font-weight: 600;
  color: var(--text-dim);
}
.share-blank {
  margin: 0; padding: var(--sp-6) 0; text-align: center;
  color: var(--text-dim); font-size: var(--fs-sm);
}

/* ---------- donut ---------- */
/* The ring and its legend, side by side, collapsing to stacked when the panel is narrow. The
   legend is the reading and the ring is the glance — see the note in chart.ts — so on a narrow
   panel the legend goes UNDER the ring rather than the ring shrinking to make room for it. */
/* The legend is CAPPED and the pair is grouped to the left. With a 1fr track the count column
   was pushed to the far edge of the panel — on a wide card the number ended up hundreds of
   pixels from the name it belonged to, which is the one relationship a legend exists to state.
   24rem is where the longest severity label plus a five-figure count stops needing more. */
.donut {
  margin: 0; display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 24rem);
  justify-content: start;
  gap: clamp(var(--sp-4), 3cqi, var(--sp-6)); align-items: center;
  container: donut / inline-size;
}
@container page (max-width: 40rem) {
  .donut { grid-template-columns: minmax(0, 1fr); justify-content: stretch; justify-items: center; }
}
/* The ring is a square that follows the panel between a floor and a ceiling. The total sits in
   the hole, which is what makes a donut worth drawing rather than a pie: the middle of a pie is
   the one part of it that carries no data. */
.donut-ring { position: relative; width: clamp(7rem, 34cqi, 10rem); aspect-ratio: 1; }
.donut-ring svg {
  display: block; width: 100%; height: 100%;
  /* Arcs are drawn from three o'clock. A quarter turn back puts the first slice at the top,
     which is where a reader starts. */
  transform: rotate(-90deg);
}
.donut-track { fill: none; stroke: var(--surface-2); stroke-width: 4.4; }
/* One rule for every arc: the tone variable supplies the colour, exactly as it does for a row's
   spine and a badge's dot. stroke-linecap stays butt — a round cap on a 4.4-unit stroke
   overhangs its neighbour by half that on each side, which on a small slice draws an arc wider
   than its own share. */
.donut-arc {
  fill: none; stroke: var(--spine, var(--border-strong)); stroke-width: 4.4;
}
/* Centred in the hole by the same inset-0 grid the ring uses, so it stays centred at every
   size without a transform to fight the SVG's own rotation. */
.donut-total {
  position: absolute; inset: 0; margin: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  line-height: 1.1; pointer-events: none;
}
.donut-total b {
  font-size: var(--fs-lg); font-weight: 640; letter-spacing: -.03em;
  font-variant-numeric: tabular-nums;
}
.donut-total span {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim);
}
/* The legend, and the half of the figure that survives greyscale. Each row is swatch, name,
   count — the count right-aligned into its own column so a reader can run down the numbers
   without reading the names. */
.donut-legend {
  list-style: none; margin: 0; padding: 0; min-width: 0;
  display: flex; flex-direction: column; gap: var(--sp-2);
  width: 100%;
}
.donut-legend li { font-size: var(--fs-sm); }
/* The grid moved off the <li> and onto whatever is inside it, so a linked row and an inert one
   lay out identically — the anchor takes the grid when there is one, the li keeps it when
   there is not. Without this the anchor would be a third grid item and the three cells would
   collapse into one. */
.donut-legend li > a,
.donut-legend li > .donut-swatch {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center; gap: var(--sp-3);
}
.donut-legend li > a {
  color: inherit; text-decoration: none;
  margin: calc(var(--sp-1) * -1) calc(var(--sp-2) * -1);
  padding: var(--sp-1) var(--sp-2); border-radius: var(--r-sm);
}
/* An inert row has no anchor to carry the grid, so the li carries it instead. */
.donut-legend li:not(:has(> a)) {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center; gap: var(--sp-3);
}
.donut-swatch {
  width: .625rem; height: .625rem; border-radius: 3px;
  background: var(--spine, var(--border-strong));
}
.donut-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.donut-n {
  font-family: var(--font-data); font-variant-numeric: tabular-nums;
  font-weight: 600; color: var(--text-dim);
}
/* Same shape as the line chart's empty state, for the same reason: a window nothing fired in is
   the ordinary case on a fresh deployment, not an error. */
.donut-blank {
  grid-column: 1 / -1; margin: 0; padding: var(--sp-8) 0; text-align: center;
  color: var(--text-dim); font-size: var(--fs-sm);
}

/* ---------- topology: the dependency map ---------- */
/* The map is React Flow now (src/dashboard/client/), so every node is an HTML element rather
   than an SVG <rect> + <text> pair. The COLOUR DISCIPLINE is unchanged and is the part worth
   restating, because it is the part that was reasoned about rather than drawn:

   Every card is on the SAME fill, so there is exactly one text-on-background pair in the whole
   figure (--text on --surface: 17.82:1 light, 14.58:1 dark) and no group's colour can break
   label legibility. An earlier revision coloured cards by ROLE — blue inbound, green outbound,
   red backends. It was pretty and it lied: red means "critical" on every other page here, so a
   healthy backend read as a broken one, and green implied a health check this page never
   performs (nothing is probed; it is config read back). Role is carried by POSITION — dagre
   ranks the columns from the edges — which leaves the border free for the only two things in
   this figure that are actually STATE. Each clears the 3:1 a non-text graphic needs:
     --warning  not configured                                  3.85 light / 5.79 dark
     --accent   reached over SQS via llm-worker (the one fact
                this map exists to make obvious)                6.17 / 8.49
   Everything structural is --mark-line (3.63 / 4.39), NOT --border-strong (1.65 / 1.69): in the
   light scheme --surface and --surface-raised are the same white, so a card is nothing but its
   outline and there is no fill contrast to fall back on. The agent's own card is --text at 2px:
   the subject of the map earns weight, not hue. The structural kinds carry no colour by design
   — a tool family especially, since the agent knows the server ADVERTISED it, not that calling
   it works, and any colour there would be a health claim.
   THE CARDS THEMSELVES ARE NO LONGER STYLED HERE. They moved to Tailwind + shadcn in
   client/nodes.tsx when the map adopted them; the reasoning above travelled with them and is
   restated at the nodeCard cva. What is left in this file is React Flow's own furniture —
   edges, controls, the dot grid — which are library-generated classes and stay plain CSS. */

/* React Flow measures its own canvas from this element and renders nothing if it collapses, so
   the height is stated rather than derived. clamp() rather than a fixed number for the same
   reason the rest of the dashboard uses one: the frame is 14.5rem narrower with a rail beside
   it, and a map that is a letterbox on a laptop is not worth the pixels it saves on a phone. */
/* Taller than it was (26/58vh/42), and the reason is fitView: it scales the whole graph into
   this box, so the frame's height IS the map's opening zoom. At the old height the map loaded
   at 0.82 — every card rendered at 82% of the type scale it was designed against, which is why
   it read as too far out. Measured after the change, not guessed. */
.topo-view { height: clamp(34rem, 74vh, 58rem); width: 100%; }
/* Replaced by the mount as its first act; visible only if the bundle never ran. Centred rather
   than parked at the top-left, because at that point it is the entire contents of the frame.
   On #topo-root, not .topo-view: the client renders .topo-view INSIDE the mount, so the note
   and the canvas are never the same element. */
#topo-root[data-fallback] { display: grid; place-items: center; padding: var(--sp-6); }
.topo-fallback { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); text-align: center; }

/* ---------- topology: React Flow's own furniture ---------- */
/* The library ships a light-grey visual language of its own. These rules are the whole of the
   theming: everything else it draws is either invisible (handles) or already neutral. */
.react-flow__node { font-family: var(--font-ui); cursor: default; }
/* The canvas is the card it sits in. React Flow paints its own ground — white in its light
   mode, a neutral #141414 in its dark one — and the neutral reads as a grey hole in an
   indigo-black page. --xy-background-color is the library's own override hook and outranks
   both of its defaults, so one declaration covers both schemes and both maps. */
.react-flow { --xy-background-color: var(--surface); }
/* The map does not connect anything (nodesConnectable={false}), so a handle is a dot that
   promises an interaction which does not exist. */
.react-flow__handle {
  width: 7px; height: 7px; min-width: 0; min-height: 0;
  background: var(--surface); border: 1.5px solid var(--mark-line);
  pointer-events: none;
}
.react-flow__node:hover .react-flow__handle { border-color: var(--accent); }
/* Structure, on the same ramp as a node's outline — an arrow is nothing but its stroke. */
.react-flow__edge-path { stroke: var(--mark-line); stroke-width: 1.5; }
.react-flow__arrowhead * { fill: var(--mark-line); stroke: none; }
/* The SQS edge is the one moving thing on the page. It is also the one edge with a colour,
   and both are spent on the same fact. */
.topo-edge-sqs .react-flow__edge-path { stroke: var(--accent); stroke-width: 2; }
.react-flow__edge.selected .react-flow__edge-path { stroke: var(--accent); }
/* A dot grid is a texture: it carries nothing, so no contrast requirement applies. This note
   exists so 1.30:1 is not "fixed" later by someone matching the numbers above. */
.react-flow__background pattern circle { fill: var(--border); }
.react-flow__controls {
  box-shadow: none; border: 1px solid var(--border); border-radius: var(--radius-sm, 6px);
  overflow: hidden;
}
.react-flow__controls-button {
  background: var(--surface); border-bottom: 1px solid var(--border);
  fill: var(--text-dim); width: 26px; height: 26px;
}
.react-flow__controls-button:hover { background: var(--surface-2); fill: var(--text); }
.react-flow__controls-button:last-child { border-bottom: none; }
/* Kept, not hidden. @xyflow/react is MIT and free, and its authors ask that the attribution
   stay unless you hold a Pro licence — so it stays, dimmed to the weight of a caption rather
   than removed with the proOptions flag. */
.react-flow__attribution { background: transparent; font-size: var(--fs-3xs, .625rem); }
.react-flow__attribution a { color: var(--text-dim); text-decoration: none; }

/* ---------- topology: the expand animation ---------- */
/* Opening a family re-runs dagre over the whole graph, so every card moves. React Flow writes
   position as a transform, which means one transition on the wrapper animates the entire
   re-layout — no per-node bookkeeping, no interpolation loop, nothing to keep in step.
   .dragging is React Flow's own class and the exemption is not optional: a transition on the
   node under the pointer makes a drag lag behind the cursor by exactly this duration. */
.react-flow__node { transition: transform .28s ease; }
.react-flow__node.dragging { transition: none; }
/* The tools themselves are new elements rather than moved ones, so they fade rather than
   slide. @starting-style is what gives a just-inserted element something to animate FROM;
   where it is unsupported the node simply appears, which is the old behaviour. */
@starting-style {
  .react-flow__node { opacity: 0; }
}

/* Marching dashes are a marquee, and a marquee is exactly what a reader who asked for less
   motion asked to be rid of — more so now that every edge has them rather than one. Nothing is
   lost by stopping: motion here says the map is live, and the SQS edge's meaning was moved onto
   its accent stroke, which does not move. */
@media (prefers-reduced-motion: reduce) {
  .react-flow__edge.animated .react-flow__edge-path { animation: none; }
  /* The re-layout still happens — it has to, the tools need the room — it just arrives rather
     than travels. */
  .react-flow__node { transition: none; }
}

/* :target on the far end is what confirms the trip landed. An outline again, for the same
   reason: --spine already carries the row's severity, and borrowing it here would swap a
   permanent signal for a transient one. */
tbody tr:target { outline: 2px solid var(--accent); outline-offset: -2px; }
/* scroll-margin, not a scroll handler: below 60rem the rail is a sticky bar, and an anchor
   jump would otherwise park the row underneath it. Unconditional because the cost on a wide
   screen — where the rail is a column and overlaps nothing — is a row that lands a line lower
   than the top of the viewport, which is where you would want it anyway. */
tbody tr:target td { scroll-margin-top: 5rem; }
/* /topology's map links to the list's cards and tool families (2026-11-19) — same confirmation. */
.topo-list [id]:target:not(dialog) { outline: 2px solid var(--accent); outline-offset: 2px; scroll-margin-top: 5rem; }

details > summary { cursor: pointer; font-weight: 550; }
details > summary > span { margin-left: .35em; }

/* ---------- hover ---------- */
/* Pointer-only, all of it. See the note beside the base link rule: a touch device latches
   :hover on the last thing tapped, so these are states a phone can enter but never leave. */
@media (hover: hover) {
  a:hover { text-decoration-color: var(--accent); }
  h2 a:hover { text-decoration: underline; }
  a.standalone:hover { text-decoration: underline; }
  /* Half the current item's ground, so pointing at a destination never looks like being on it. */
  .rail nav a:hover { color: var(--text); background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
  .rail nav a[aria-current="page"]:hover { color: var(--text); background: var(--surface-2); }
  .seg a:not([aria-current="true"]):hover { color: var(--text); }
  .theme a:not([aria-current="true"]):hover { color: var(--text); }
  .brand:hover { color: var(--rail-accent); }
  tbody tr:hover { background: var(--surface-2); }
  /* The row is the target and the whole of it responds — but the name is what gets clicked, so
     it is the part that picks up the colour and the underline it gave up at rest. */
  tbody tr:hover td.primary a { color: var(--accent); text-decoration: underline; }
  /* The card lifts. This is the one place a transform is used for a hover state, and it is
     worth the pixel: a shelf of KPI cards that only changed border colour read as static
     panels rather than as the surfaces the shadow says they are.
     translateY, not scale — a scaled card resamples its own text. */
  /* Scoped to [data-linked], and that is the whole point of the attribute. A card that lifts
     under the pointer is telling the reader it can be clicked; before this it lifted on the
     incident page's fact shelf and on the tiles inside the outcomes panel, neither of which
     goes anywhere. The restyle is what created the lie — flat tiles promised nothing. */
  .stat[data-linked]:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
  .stat[data-linked][data-tone]:hover {
    box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent), var(--shadow-md);
  }
  .stat[data-linked]:hover .stat-link { color: var(--accent); }
  /* The lead tile is already the accent: it lifts like its neighbours, without the spine it
     never had and without turning its own label the colour of the ground under it. */
  .stat[data-lead][data-linked][data-tone]:hover { box-shadow: var(--shadow-md); }
  .stat[data-lead][data-linked]:hover .stat-link { color: inherit; }
  form.filters button:hover, .signin-form button:hover { filter: brightness(1.08); }
  form.signout button:hover { color: var(--text); background: var(--surface-2); }
  .pages a:hover { border-color: var(--accent); color: var(--accent); }
  .chips a:hover { background: var(--surface-raised); color: var(--text); }
  .share-legend li > a:hover { background: var(--surface-2); }
  .donut-legend li > a:hover { background: var(--surface-2); }
  .rank a:hover { color: var(--accent); text-decoration: underline; }
  .ns-list a:not([aria-current="true"]):hover { background: var(--surface-2); }
  .toc a:hover { background: var(--surface-2); color: var(--accent); }
  .chips-list a:hover { border-color: var(--accent); color: var(--accent); }
  .skill-card header a:hover { text-decoration: underline; }
  /* The dot grows rather than changing colour: the accent is the line's identity, and a point
     that turns a different hue on hover reads as a different KIND of point. */
  .chart-col:hover .chart-dot { transform: scale(1.5); }
  .chart-col[data-current]:hover .chart-dot { transform: scale(1.35); }
  .chart-col:hover .chart-value { color: var(--text); }
}

/* ---------- inline bars in table cells (harness) ---------- */
/* A share split into its parts: one track, one segment per part. Each segment carries its key's
   mark colour AND the legend beside it names the part and its count — never colour alone. */
.stack-bar {
  display: flex; width: 100%; max-width: 18rem; height: 8px; margin-bottom: var(--sp-2);
  border-radius: var(--r-pill); background: var(--surface-2); overflow: hidden;
}
.stack-bar > span { width: calc(var(--w, 0) * 1%); }
.stack-legend { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-4); font-size: var(--fs-sm); color: var(--text-dim); }
.stack-legend > span { display: inline-flex; align-items: center; gap: var(--sp-1); white-space: nowrap; }
.stack-legend i { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
[data-k="accepted"] { background: var(--mark-ok); }
[data-k="restored"] { background: var(--mark-info); }
[data-k="kept-earlier"] { background: var(--mark-warning); }
/* The context budget split: what is spent before the conversation starts, then what is left. */
[data-k="reserve"] { background: var(--mark-line); }
[data-k="core"] { background: var(--accent); }
[data-k="tools"] { background: var(--mark-info); }
[data-k="available"] { background: var(--mark-ok); }
.stack-bar.budget { margin: var(--sp-2) 0 0; max-width: 14rem; }
p.stack-legend { margin-bottom: var(--sp-3); }
/* Latency as a range: the pale run is p95, the solid head is p50, both against the slowest p95
   on the page. The two spans overlap from the left edge, so the head is drawn second. */
.lat-bar {
  position: relative; display: block; width: 100%; min-width: 6rem; max-width: 14rem; height: 8px;
  border-radius: var(--r-pill); background: var(--surface-2); overflow: hidden;
}
.lat-bar > span { position: absolute; inset: 0 auto 0 0; width: calc(var(--w, 0) * 1%); border-radius: inherit; }
.lat-bar > span:first-child { background: color-mix(in srgb, var(--accent) 35%, transparent); }
.lat-bar > span:last-child { background: var(--accent); }
.ratio.under { margin: var(--sp-1) 0 0; max-width: 7rem; }

/* ---------- /nodes ---------- */
/* Host memory in three parts: anonymous (what the kernel cannot take back), cache and the rest in
   use, and what is still available. The legend names each with its number — never colour alone. */
[data-k="mem-anon"] { background: var(--accent); }
[data-k="mem-other"] { background: color-mix(in srgb, var(--accent) 35%, transparent); }
[data-k="mem-free"] { background: var(--mark-ok); }
.node-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 30rem), 1fr));
  gap: var(--sp-4); margin-bottom: var(--sp-6);
}
.node-card { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.node-badges { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.node-row { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: var(--sp-2); align-items: start; }
.node-label { font-size: var(--fs-sm); color: var(--text-dim); }
.stack-bar.node-mem { max-width: none; }
.node-row .rate-bar { width: 45%; }
.node-meter-text { margin-left: var(--sp-2); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.node-row p.meta { margin: var(--sp-1) 0 0; }
.node-tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: var(--sp-3); }
.node-facts { margin: 0; }
/* The fleet: one card per cluster (and one for standalone hosts), a table inside each. */
.node-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-4); }
.node-toggle {
  padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface); font-size: var(--fs-sm); text-decoration: none; color: var(--text);
}
.node-toggle[aria-current="true"] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.node-search { flex: 1 1 14rem; min-width: 0; }
.node-search input {
  box-sizing: border-box; width: 100%; font: inherit; font-size: var(--fs-sm); color: var(--text);
  padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface);
}
.node-group { margin-bottom: var(--sp-5); }
.node-group-head {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border);
}
.node-group-title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.node-group-title .card-title { margin: 0; }
.node-holders {
  display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-5); margin: 0; padding: var(--sp-2) var(--sp-4);
  background: var(--surface-2); font-size: var(--fs-sm); color: var(--text-dim);
}
.node-holders strong { color: var(--text); font-weight: 600; }
.node-group-note, .node-group-empty { margin: 0; padding: var(--sp-3) var(--sp-4); }
.node-group-empty p { margin: var(--sp-1) 0 0; }
.node-group tr[data-attention] > td { background: var(--tint-warning); }
.node-host { font-weight: 600; }
.node-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 0 .35em; font-size: var(--fs-xs); color: var(--text-dim); }
/* The kind of host, as a glyph in a chip before its name: control plane, worker, standalone VM.
   The line under the name says the same in words, so the chip is decoration and is hidden from
   assistive technology. */
.host-cell { display: flex; align-items: center; gap: var(--sp-3); }
.host-kind {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  width: 2rem; height: 2rem; border-radius: var(--r-sm); background: var(--surface-2); color: var(--text-dim);
}
.host-kind[data-kind="cp"] { background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent); }
.host-kind[data-kind="vm"] { background: var(--surface); border: 1px solid var(--border); }
/* The lease glyphs, in the row's line and in the group's holder strip: the pin is the API VIP,
   the crown a leader. Coloured, never alone — the word is beside each. */
.node-sub .ico, .node-holders .ico { width: 13px; height: 13px; vertical-align: -2px; }
.ico-vip { display: inline-flex; color: var(--info); }
.ico-lead { display: inline-flex; color: var(--warning); }
.node-holders span { display: inline-flex; align-items: center; gap: var(--sp-1); }
.node-cell-bar { display: block; width: 100%; max-width: 11rem; height: 6px; }
.node-cell-text { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-dim); white-space: nowrap; }
.node-group td [data-tone], .node-cell-text[data-tone] { color: var(--ink); font-weight: 600; }
.node-notes, .node-map { margin-bottom: var(--sp-4); }
.node-map .node-holders { background: none; padding: 0 0 var(--sp-1); }
.node-map p.meta { margin: 0; }

/* A control plane's memory as one budget, pods at the bottom, what is left at the top. The dashed
   line is allocatable: the pods' parts crossing it is what raises MemoryPressure. Each part has its
   number in the legend beside the bar, so no part is read by colour alone. */
.budget-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: var(--sp-5); margin-bottom: var(--sp-5); }
.budget-col { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.budget-name { margin: 0; font-weight: 650; }
.budget-body { display: flex; gap: var(--sp-3); align-items: stretch; }
.budget-bar {
  position: relative; flex: 0 0 4.5rem; height: 20rem; display: flex; flex-direction: column-reverse;
  border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; background: var(--surface-2);
}
.budget-bar > span:not(.budget-line) { flex: 0 0 auto; height: calc(var(--h, 0) * 1%); }
.budget-line { position: absolute; left: 0; right: 0; bottom: calc(var(--at, 0) * 1%); border-top: 2px dashed var(--text); }
.budget-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; justify-content: space-between; gap: var(--sp-1); font-size: var(--fs-sm); min-width: 0; }
.budget-legend li { display: flex; align-items: center; gap: var(--sp-2); }
.budget-legend li span { flex: 1 1 auto; color: var(--text-dim); }
.budget-legend li strong { font-weight: 600; font-variant-numeric: tabular-nums; }
.budget-legend i { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; }
.budget-alloc { border-top: 1px dashed var(--border-strong); padding-top: var(--sp-1); }
[data-k="b-apiserver"] { background: var(--brand-600); }
[data-k="b-controller"] { background: var(--brand-400); }
[data-k="b-pods"] { background: color-mix(in srgb, var(--brand-400) 45%, var(--surface)); }
[data-k="b-etcd"] { background: var(--mark-warning); }
[data-k="b-runtime"] { background: color-mix(in srgb, var(--mark-warning) 45%, var(--surface)); }
[data-k="b-os"] { background: var(--mark-line); }
[data-k="b-free"] { background: color-mix(in srgb, var(--mark-ok) 30%, var(--surface)); }
/* ---------- /topology: the list under the map, grouped by what each dependency is for ---------- */
.topo-list { display: flex; flex-direction: column; gap: var(--sp-6); margin-top: var(--sp-6); }
.topo-section { display: flex; flex-direction: column; gap: var(--sp-3); }
.topo-section > h2, .topo-tools-head > h2 { margin: 0; }
.topo-head-note { font-size: var(--fs-sm); font-weight: 400; color: var(--text-dim); }
.topo-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: var(--sp-3); }
.topo-dep { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.topo-dep-head { display: flex; gap: var(--sp-3); align-items: flex-start; }
.topo-glyph {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 2.25rem; height: 2.25rem;
  border-radius: var(--r-sm); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent);
}
.topo-dep-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.topo-endpoint { font-family: var(--font-data); font-size: var(--fs-xs); color: var(--text-dim); overflow-wrap: anywhere; }
.topo-meta { font-size: var(--fs-xs); color: var(--text-dim); }
.topo-holds, .topo-chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.topo-holds li code, .topo-chips li code {
  display: inline-block; padding: 2px 8px; border-radius: 6px; background: var(--surface-2);
  font-size: var(--fs-xs); overflow-wrap: anywhere;
}
.topo-dep[data-tone="warning"] { border-color: color-mix(in srgb, var(--spine) 45%, var(--border)); }
.topo-tools-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-2) var(--sp-4); }
.topo-search { flex: 0 1 20rem; min-width: 0; }
.topo-search input {
  box-sizing: border-box; width: 100%; font: inherit; font-size: var(--fs-sm); color: var(--text);
  padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface);
}
/* auto-fit, not auto-fill: a row of seven tiles on a wide screen must share the width, not leave the
   empty tracks auto-fill keeps for tiles that do not exist. */
.topo-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr)); gap: var(--sp-2); }
/* A tile is a way in, so it looks like one: raised at rest, lifted under the pointer and on focus. */
.topo-tile {
  display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); text-decoration: none; color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-sm);
  box-shadow: var(--shadow-sm); transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
}
.topo-tile:focus-visible, .topo-tile[aria-current="true"] {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); box-shadow: var(--shadow-md); transform: translateY(-2px);
}
@media (hover: hover) {
  .topo-tile:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); box-shadow: var(--shadow-md); transform: translateY(-2px); }
}
@media (prefers-reduced-motion: reduce) { .topo-tile { transition: none; } .topo-tile:hover, .topo-tile:focus-visible { transform: none; } }
.topo-tile code { font-weight: 600; font-size: var(--fs-sm); }
.topo-tile strong { font-size: 1.375rem; line-height: 1.2; }
.topo-tile span { font-size: var(--fs-xs); color: var(--text-dim); }
.topo-tile.has-write span { color: var(--warning); font-weight: 600; }
/* The agent's own family looks like every other tile; where its tools come from is said in words. */
.topo-tile-origin { font-style: normal; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
.topo-tile.is-empty { opacity: .55; }
.topo-family { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.topo-family-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--sp-1) var(--sp-3); }
.topo-family-head h3 { margin: 0; font-size: var(--fs-md); display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.topo-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr)); gap: var(--sp-4) var(--sp-5); }
.topo-group-title { margin: 0 0 var(--sp-1); font-size: var(--fs-xs); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-dim); }
/* The write tools, set apart in the warning tint: the most consequential fact on this page is
   which tools can change the cluster, and each names the guard that stands in its way. */
.topo-writes {
  display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm); background: var(--tint-warning);
  border: 1px solid color-mix(in srgb, var(--mark-warning) 30%, transparent);
}
.topo-writes-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--sp-1) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
.topo-writes-head strong { color: var(--warning); letter-spacing: .04em; text-transform: uppercase; }
.topo-writes-head span { color: var(--text-dim); }
.topo-write-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: var(--sp-4); }
.topo-write-grid p.meta { margin: var(--sp-1) 0 0; }
.topo-write-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
.topo-write-list code { font-size: var(--fs-xs); }
/* A family's tools as a <dialog> (client/tool-dialogs.ts opens it with showModal): its groups down the
   left, the chosen group's tool cards on the right. The browser draws it on the top layer, so it needs
   no z-index, and ::backdrop is the scrim. */
dialog.topo-dialog {
  padding: 0; border: 0; border-radius: var(--r-lg); background: var(--surface); color: var(--text);
  width: min(68rem, calc(100vw - 2rem)); height: min(48rem, calc(100vh - 3rem)); max-width: none; max-height: none;
  box-shadow: 0 24px 64px rgba(22, 26, 43, .32); overflow: hidden;
}
dialog.topo-dialog::backdrop { background: rgba(22, 26, 43, .5); }
.topo-split { display: flex; height: 100%; min-height: 0; }
.topo-split-nav {
  flex: 0 0 16rem; display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-5) var(--sp-3);
  background: var(--surface-2); border-right: 1px solid var(--border); overflow-y: auto;
}
.topo-split-name { display: flex; flex-direction: column; gap: 2px; padding: 0 var(--sp-2) var(--sp-3); }
.topo-split-name h2 { margin: 0; font-size: var(--fs-lg); }
.topo-split-tabs { display: flex; flex-direction: column; gap: 2px; }
.topo-split-tab {
  display: flex; justify-content: space-between; gap: var(--sp-2); width: 100%; padding: var(--sp-2) var(--sp-3);
  border: 0; border-radius: var(--r-sm); background: none; color: var(--text); font: inherit; font-size: var(--fs-sm);
  text-align: left; cursor: pointer;
}
.topo-split-tab:hover { background: color-mix(in srgb, var(--surface) 70%, transparent); }
.topo-split-tab[aria-selected="true"] { background: var(--surface); box-shadow: var(--shadow-sm); font-weight: 600; }
.topo-split-tab.is-write { margin-top: var(--sp-2); color: var(--warning); }
.topo-split-tab.is-write[aria-selected="true"] { background: var(--tint-warning); }
.topo-split-count { color: var(--text-dim); font-variant-numeric: tabular-nums; font-weight: 400; }
.topo-split-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.topo-split-bar { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); border-bottom: 1px solid var(--border); }
.topo-split-bar form { margin: 0; }
.topo-dialog-filter { flex: 1 1 auto; display: flex; }
.topo-dialog-filter input {
  box-sizing: border-box; width: 100%; font: inherit; font-size: var(--fs-sm); color: var(--text);
  padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface);
}
.topo-dialog-close {
  display: inline-flex; align-items: center; justify-content: center; width: 2.5rem; height: 2.5rem;
  border: 0; border-radius: 50%; background: var(--surface-2); color: var(--text); font: inherit; cursor: pointer;
}
.topo-split-panels { flex: 1 1 auto; overflow-y: auto; padding: var(--sp-4) var(--sp-5) var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-5); }
.topo-split-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--sp-3); }
.topo-split-head h3 { margin: 0; font-size: var(--fs-md); }
.topo-split-head p.meta { margin: 0; }
.topo-tool-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.topo-tool-card {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-sm); box-shadow: var(--shadow-sm);
}
.topo-tool-card > div { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.topo-tool-card code { font-weight: 600; overflow-wrap: anywhere; }
.topo-tool-card p { margin: 0; font-size: var(--fs-sm); color: var(--text-dim); }
.topo-tool-card p.topo-guard { color: var(--warning); }
.topo-tool-card.is-write { border-color: color-mix(in srgb, var(--mark-warning) 35%, var(--border)); background: var(--tint-warning); }
.topo-split-panel[hidden], .topo-tool-card[hidden] { display: none; }
@media (max-width: 40rem) {
  .topo-split { flex-direction: column; }
  .topo-split-nav { flex: 0 0 auto; border-right: 0; border-bottom: 1px solid var(--border); padding: var(--sp-3); }
  .topo-split-tabs { flex-direction: row; overflow-x: auto; }
  .topo-split-tab { width: auto; white-space: nowrap; }
  .topo-split-tab.is-write { margin-top: 0; }
}
.topo-result + .topo-result { margin-top: var(--sp-3); }
.topo-lane { display: flex; flex-direction: column; gap: var(--sp-2); }
.topo-backends { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.topo-backends li { display: flex; flex-direction: column; gap: 2px; }
@media (max-width: 40rem) {
  .node-row { grid-template-columns: minmax(0, 1fr); gap: var(--sp-1); }
  .node-row .rate-bar { width: 100%; }
  .node-meter-text { display: block; margin: var(--sp-1) 0 0; }
  .budget-bar { flex-basis: 3.5rem; height: 16rem; }
}
`;
