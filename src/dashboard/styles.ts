// One stylesheet, inlined into every page. No build step and no CDN, so everything the
// page needs must be in the document. Components read only from the tokens at the top —
// never hard-code a colour below :root.
export const STYLES = `
:root {
  --fs-xs: .75rem; --fs-sm: .875rem; --fs-base: 1rem;
  --fs-lg: 1.25rem; --fs-xl: 1.75rem; --fs-metric: 2.5rem;
  --sp-1: .25rem; --sp-2: .5rem; --sp-3: .75rem;
  --sp-4: 1rem; --sp-6: 1.5rem; --sp-8: 2rem;
  --radius: 8px; --maxw: 1200px;

  --bg: #fbfbfd; --surface: #fff; --surface-2: #f4f4f7;
  --border: #e4e4e9; --text: #1a1a1f; --text-dim: #6b6b76;
  --accent: #3b5bdb;
  --critical: #d63939; --warning: #d99400; --info: #3b7cd6; --ok: #2f9e63;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121216; --surface: #1a1a20; --surface-2: #22222a;
    --border: #2a2a33; --text: #e8e8ed; --text-dim: #9a9aa5;
    --accent: #7c93f5;
    --critical: #f06565; --warning: #e8b04b; --info: #6ba6f5; --ok: #4fc384;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font); font-size: var(--fs-sm); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

header.top {
  position: sticky; top: 0; z-index: 10;
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: var(--sp-3) var(--sp-6);
  display: flex; align-items: baseline; gap: var(--sp-6);
}
header.top .brand { font-weight: 650; font-size: var(--fs-base); letter-spacing: -.01em; }
header.top nav { display: flex; gap: var(--sp-4); }
header.top nav a { color: var(--text-dim); font-weight: 500; }
header.top nav a:hover, header.top nav a[aria-current] { color: var(--text); text-decoration: none; }

main { max-width: var(--maxw); margin: 0 auto; padding: var(--sp-8) var(--sp-6); }
h1 { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -.02em; margin: 0 0 var(--sp-6); }
h2 { font-size: var(--fs-lg); font-weight: 600; margin: var(--sp-8) 0 var(--sp-4); }

.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--sp-4); }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4) var(--sp-4) var(--sp-3); }
.metric .label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); }
.metric .value { font-size: var(--fs-metric); font-weight: 620; letter-spacing: -.03em; line-height: 1.1; margin-top: var(--sp-2); font-variant-numeric: tabular-nums; }
.metric .sub { font-size: var(--fs-xs); color: var(--text-dim); }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4); }

table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
th { text-align: left; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); font-weight: 600; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); }
td { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }
td.num { font-variant-numeric: tabular-nums; }
td.when { color: var(--text-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }

.pill { display: inline-block; font-size: var(--fs-xs); font-weight: 600; padding: 2px var(--sp-2); border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.pill.critical { color: var(--critical); }
.pill.warning  { color: var(--warning); }
.pill.info     { color: var(--info); }
.pill.ok, .pill.succeeded, .pill.resolved { color: var(--ok); }
.pill.failed, .pill.rejected { color: var(--critical); }
.pill.proposed, .pill.approved, .pill.executing { color: var(--text-dim); }

form.filters { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: end; margin-bottom: var(--sp-4); }
form.filters label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-dim); }
form.filters input, form.filters select {
  font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: var(--sp-2) var(--sp-3); min-width: 150px;
}
form.filters button {
  font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  background: var(--accent); color: #fff; border: 0;
  border-radius: 6px; padding: var(--sp-2) var(--sp-4);
}
form.filters button:hover { filter: brightness(1.08); }

.rca { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4); white-space: pre-wrap; word-break: break-word; font-size: var(--fs-sm); line-height: 1.65; }
code, .mono { font-family: var(--mono); font-size: .92em; }

.empty { text-align: center; color: var(--text-dim); padding: var(--sp-8); border: 1px dashed var(--border); border-radius: var(--radius); }
.pager { display: flex; gap: var(--sp-3); margin-top: var(--sp-4); }
.meta { color: var(--text-dim); font-size: var(--fs-xs); }

.chart { width: 100%; height: auto; display: block; }
.chart-bar { fill: var(--accent); }
.chart-bar:hover { filter: brightness(1.15); }
.chart-label, .chart-empty { fill: var(--text-dim); font-size: 10px; font-family: var(--font); }

.topo-box { fill: var(--surface-2); stroke: var(--border); }
.topo-self { fill: var(--accent); }
/* Immediate-sibling only. topologyDiagram() emits every <rect>/<text> as flat siblings of
   <svg> (no per-row <g>), so the general-sibling combinator (~) would match every later
   .topo-label in the document, not just this box's own — that made most of the diagram's
   text render white-on-near-white in light mode. box() always emits a label as the very
   next sibling of its own rect, so "+" alone is correct and sufficient. */
.topo-self + .topo-label { fill: #fff; }
.topo-label { fill: var(--text); font-size: 11px; font-family: var(--font); }
.topo-edge { stroke: var(--border); stroke-width: 1.5; }

/* Group identity lives on STROKE, not fill. A first attempt varied fill instead
   (--surface/--surface-2/--border) and measured out at only 1.10-1.27:1 contrast between
   adjacent groups — nowhere near WCAG's 3:1 bar for adjacent UI elements, because those
   three tokens are deliberately close to each other (they're a subtle background-layer
   ramp, not a set of distinguishable hues). Fills stay exactly those neutral values —
   that's what keeps the default var(--text) label legible in both themes (see the .topo-in
   / .topo-out / .topo-backend rules below) — and the stroke below carries the entire
   group-vs-group distinction instead. Splitting the two constraints this way means neither
   can break the other again, which is what both of this task's colour bugs had in common.

   --warning was tried for the stroke and rejected: computed against every one of
   --surface/--surface-2/--border in light mode it tops out at 2.57:1 (surface), 2.34:1
   (surface-2), 2.02:1 (border) — below 3:1 against all three, not just the one it ended up
   paired with. --ok also fails specifically against --border (2.68:1), which is why it's
   not used for .topo-backend below. WCAG contrast, stroke vs the box's own fill, computed
   from the hex values above (light / dark):
     .topo-in              info     / surface    4.17:1 / 6.93:1
     .topo-out              ok      / surface-2  3.09:1 / 7.12:1
     .topo-backend          critical/ border      3.68:1 / 4.57:1
     .topo-backend-worker   accent  / border      4.47:1 / 4.97:1
   all >= 3:1 in both colour schemes. */
.topo-in { fill: var(--surface); stroke: var(--info); stroke-width: 2; }
.topo-out { fill: var(--surface-2); stroke: var(--ok); stroke-width: 2; }
.topo-backend { fill: var(--border); stroke: var(--critical); stroke-width: 2; }
/* The one fact this diagram exists to make obvious (design §4.2): only private-llm
   backends traverse SQS to llm-worker. --accent keeps this visually distinct from the
   plain --critical backend stroke above (and from --info/--ok used elsewhere); the fill
   stays the same var(--border) inherited from .topo-backend, so only the stroke changes. */
.topo-backend-worker { stroke: var(--accent); stroke-width: 2.5; }
`;
