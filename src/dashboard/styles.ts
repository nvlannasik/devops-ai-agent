// One stylesheet, inlined into every page. No build step and no CDN — and the CSP this
// server sends (`default-src 'none'`) blocks font-src outright, so every typeface here is
// one the operating system already has. Components read only from the tokens at the top —
// never hard-code a colour below :root.
//
// The direction: COLOUR IS RESERVED FOR SIGNAL. The chrome is graphite end to end, and the
// only saturated ink on a page is severity and state. On a console whose job is to make one
// critical row unmissable at 3am, a decorative accent on every link and every heading is
// the thing that hides the alert. Interaction (focus, current page, primary button) gets the
// single teal accent; nothing else does.
//
// Three faces, three jobs, each earned by the kind of content it carries:
//   --font-ui    the interface itself
//   --font-data  what the system MEASURED — ids, endpoints, queue names, timestamps, counts
//   --font-prose what the agent WROTE — the RCA, and nothing else
export const STYLES = `
:root {
  color-scheme: light dark;

  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-data: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", Menlo, Consolas, monospace;
  --font-prose: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, "Times New Roman", serif;

  --fs-2xs: .6875rem; --fs-xs: .75rem; --fs-sm: .8125rem; --fs-base: .9375rem;
  --fs-md: 1.0625rem; --fs-lg: 1.3125rem;
  --fs-xl: clamp(1.5rem, 1.15rem + 1.5vw, 2rem);
  --fs-hero: clamp(2.5rem, 1.6rem + 3.6vw, 3.75rem);

  --sp-1: .25rem; --sp-2: .5rem; --sp-3: .75rem; --sp-4: 1rem;
  --sp-5: 1.25rem; --sp-6: 1.5rem; --sp-8: 2rem; --sp-10: 2.5rem; --sp-12: 3rem;

  --r-sm: 5px; --r: 10px; --r-lg: 14px;
  --maxw: 76rem;
  --spine-w: 3px;
  /* The page gutter, and the notch allowance folded into it: the header is sticky, so on a
     phone held in landscape it would otherwise run under the camera cutout. env() needs its
     own fallback — without the 0px a browser that has never heard of safe areas throws the
     whole declaration away and the page loses its gutter entirely. */
  --gutter: max(var(--sp-6), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px));

  --bg: #f4f6f9; --surface: #fff; --surface-2: #eceff4;
  --border: #dde2ea; --border-strong: #c2cad7;
  --text: #121821; --text-dim: #59636f;
  --accent: #0a6c73; --on-accent: #fff;
  --glass: rgba(255, 255, 255, .78);

  --critical: #bf2f28; --warning: #8a5b00; --info: #1d5da6; --ok: #187446;
  --tint-critical: #f7e6e5; --tint-warning: #f1ebe0; --tint-info: #e4ecf4; --tint-ok: #e3eee9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --surface: #151b23; --surface-2: #1d242e;
    --border: #273040; --border-strong: #3b4655;
    --text: #e7ecf3; --text-dim: #94a1b1;
    --accent: #3ec9be; --on-accent: #0d1117;
    --glass: rgba(21, 27, 35, .78);

    --critical: #f4695f; --warning: #e0a53f; --info: #69a5ec; --ok: #4ec489;
    --tint-critical: #39272d; --tint-warning: #353127; --tint-info: #223143; --tint-ok: #1e3633;
  }
}

/* Every pair below is computed, not eyeballed — the two colour bugs this page has already
   shipped both came from guessing. Text/background ratios (light / dark):
     --text on --surface        17.82 / 14.58      --text-dim on --surface   6.11 / 6.59
     --accent on --surface       6.17 /  8.49      severity on --surface     5.75-6.63 / 5.80-7.93
   Badge text on its own tint:   critical 4.77/4.68  warning 4.95/5.94
                                 info     5.56/5.16  ok      4.87/5.88
   All >= 4.5:1, the normal-text bar, in both colour schemes. */

* { box-sizing: border-box; }
/* scrollbar-gutter keeps the reserved track on pages short enough not to scroll (topology)
   so the header and content do not jump sideways when you navigate from a long one. */
html { -webkit-text-size-adjust: 100%; scrollbar-gutter: stable; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-ui); font-size: var(--fs-base); line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  accent-color: var(--accent);
}

/* Links carry no colour by default. A table of fifty blue rows is fifty pieces of noise
   competing with the one red one — the underline is affordance enough, and the accent is
   held back for the places where colour means something. */
a { color: inherit; text-decoration: underline; text-decoration-thickness: 1px;
    text-decoration-color: var(--border-strong); text-underline-offset: .18em; }
a.standalone { color: var(--accent); font-weight: 550; }
/* Every hover state in this stylesheet lives in one block near the bottom, behind
   @media (hover: hover). A tap on a touch screen latches :hover until the next tap
   somewhere else, so an un-gated hover leaves a row highlighted after you have already
   navigated away from it and come back. */
a, button, select, input, summary { touch-action: manipulation; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm); }

.skip {
  position: absolute; left: var(--sp-3); top: var(--sp-3); z-index: 20;
  transform: translateY(-250%); background: var(--surface); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  padding: var(--sp-2) var(--sp-3); text-decoration: none; font-weight: 600;
}
.skip:focus-visible { transform: none; }

/* ---------- chrome ---------- */
header.top {
  position: sticky; top: 0; z-index: 10;
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 0 var(--gutter);
  display: flex; align-items: center; gap: var(--sp-8); flex-wrap: wrap;
}
@supports (backdrop-filter: blur(1px)) {
  header.top { background: var(--glass); backdrop-filter: blur(14px) saturate(1.6); }
}
header.top .brand {
  font-family: var(--font-data); font-size: var(--fs-sm); font-weight: 600;
  letter-spacing: -.02em; padding: var(--sp-4) 0; white-space: nowrap;
}
header.top nav { display: flex; gap: var(--sp-5); margin-left: auto; }
header.top nav a {
  color: var(--text-dim); font-size: var(--fs-sm); font-weight: 550;
  text-decoration: none; padding: var(--sp-4) 0;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
header.top nav a[aria-current="page"] { color: var(--text); border-bottom-color: var(--accent); }

main { max-width: var(--maxw); margin: 0 auto; padding: var(--sp-10) var(--gutter) var(--sp-12); }

footer.bottom {
  max-width: var(--maxw); margin: 0 auto;
  padding: 0 var(--gutter) var(--sp-10);
  color: var(--text-dim); font-family: var(--font-data); font-size: var(--fs-2xs);
}

/* ---------- type ---------- */
h1 {
  font-size: var(--fs-xl); font-weight: 640; letter-spacing: -.025em; line-height: 1.15;
  margin: 0 0 var(--sp-4); text-wrap: balance;
}
/* Section headers are instrument-panel labels: a small mono caption with a hairline running
   out to the edge of the content. Deliberately NOT numbered — these sections are a set of
   facts about one incident, not a sequence, and numbering would assert an order that is not
   there. The only place this page counts is the incident id, which is a real identifier. */
h2, .eyebrow {
  display: flex; align-items: center; gap: var(--sp-4);
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .14em; color: var(--text-dim);
  margin: var(--sp-10) 0 var(--sp-4);
}
h2::after, .eyebrow::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--border); }
/* The overview's <h1> wears .eyebrow — the class wins on everything it declares, and these two
   lines finish the job for the h1 properties it does not (a balanced 11px caption is nonsense,
   and 1.15 leading on uppercase mono sits too loose). */
.eyebrow { margin: 0 0 var(--sp-3); line-height: 1; text-wrap: wrap; }
/* Sits AFTER the hairline: ::after is the last child at order 0, so order:1 pushes the link past
   it. A section that continues elsewhere says so at the end of its own rule, not in front of it. */
h2 a {
  order: 1; font-family: var(--font-ui); font-size: var(--fs-sm); font-weight: 550;
  text-transform: none; letter-spacing: 0; color: var(--accent);
  text-decoration: none; white-space: nowrap;
}
.meta { color: var(--text-dim); font-size: var(--fs-sm); }
code, .mono { font-family: var(--font-data); font-size: .92em; }
.num, .when { font-family: var(--font-data); font-variant-numeric: tabular-nums; }
.when { color: var(--text-dim); white-space: nowrap; font-size: var(--fs-sm); }

/* ---------- panels ---------- */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r); padding: var(--sp-5);
}
/* The topology canvas draws its own dot grid edge to edge, so it gets the frame without the
   inset — padding would leave a bare gutter around a background that is meant to be full-bleed. */
.card.flush { padding: 0; overflow: hidden; }

/* The overview's opening move is one composed object, not a rank of identical metric tiles:
   the 30-day count set against the weekly series it summarises, with the supporting figures
   on a shelf underneath. The count and its shape are one fact and belong in one frame. */
.hero {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: var(--sp-6) var(--sp-6) 0;
  margin-bottom: var(--sp-8); overflow: hidden;
}
.hero-body {
  display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: var(--sp-8); align-items: end; padding-bottom: var(--sp-5);
}
.hero-figure { margin: 0; display: flex; flex-direction: column; }
.hero-value {
  font-size: var(--fs-hero); font-weight: 620; letter-spacing: -.045em; line-height: .92;
  font-variant-numeric: tabular-nums;
}
.hero-unit {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .14em; color: var(--text-dim);
  margin-top: var(--sp-3);
}
.hero-chart { min-width: 0; }

/* One stat shelf, two homes: the hero's supporting figures and the incident fact bar.
   They are the same kind of thing — a labelled value — so they are the same component. */
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  margin: 0; border-top: 1px solid var(--border);
}
.stats.boxed {
  border: 1px solid var(--border); border-radius: var(--r);
  background: var(--surface); overflow: hidden;
}
.stat { padding: var(--sp-4) var(--sp-5); border-left: 1px solid var(--border); min-width: 0; }
.stat:first-child { border-left: 0; }
.hero .stat { padding-left: 0; border-left: 0; }
.hero .stat + .stat { padding-left: var(--sp-5); border-left: 1px solid var(--border); }
.stat dt {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim);
}
.stat dd {
  margin: var(--sp-2) 0 0; font-size: var(--fs-md); font-weight: 600;
  letter-spacing: -.015em; font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.stat dd span {
  display: block; font-size: var(--fs-xs); font-weight: 400;
  letter-spacing: 0; color: var(--text-dim); margin-top: 2px;
}

/* ---------- tables ---------- */
.table-wrap {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r); overflow-x: auto;
}
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; white-space: nowrap;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
  padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border);
}
td { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }

/* The signature, and the whole point of holding colour back everywhere else: a row's
   severity is a solid bar of ink down its leading edge. It is set through a custom property
   rather than one rule per severity, so a row opts in by naming a tone and nothing else. */
tbody td:first-child {
  box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent);
  padding-left: calc(var(--sp-4) + var(--spine-w));
}
tr[data-tone="critical"] { --spine: var(--critical); }
tr[data-tone="warning"]  { --spine: var(--warning); }
tr[data-tone="info"]     { --spine: var(--info); }
tr[data-tone="ok"]       { --spine: var(--ok); }
td .sub { color: var(--text-dim); font-size: var(--fs-sm); margin-top: 2px; overflow-wrap: anywhere; }
/* The alert name is the row's only target, and at 15px/1.55 its line box is 23px — a whisker
   under the 24px a finger needs. Padding on an inline element grows the hit area without
   touching the line box, so the row stays exactly as tall as it looks. */
td.primary a { font-weight: 550; padding-block: 3px; }

/* ---------- badges ---------- */
.badge {
  display: inline-block; white-space: nowrap;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em;
  padding: .25em .5em; border-radius: var(--r-sm);
  background: var(--surface-2); color: var(--text-dim);
}
.badge[data-tone="critical"] { background: var(--tint-critical); color: var(--critical); }
.badge[data-tone="warning"]  { background: var(--tint-warning);  color: var(--warning); }
.badge[data-tone="info"]     { background: var(--tint-info);     color: var(--info); }
.badge[data-tone="ok"]       { background: var(--tint-ok);       color: var(--ok); }

/* ---------- filters ---------- */
form.filters {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--sp-3); align-items: end; margin: var(--sp-6) 0 var(--sp-6);
}
form.filters label {
  display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
}
form.filters input, form.filters select {
  font: inherit; font-family: var(--font-ui); font-size: var(--fs-sm);
  text-transform: none; letter-spacing: 0; color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); min-width: 0; width: 100%;
}
form.filters input::placeholder { color: var(--text-dim); opacity: .8; }
form.filters .actions { display: flex; gap: var(--sp-3); align-items: center; }
form.filters button {
  font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  background: var(--accent); color: var(--on-accent); border: 0;
  border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-4); white-space: nowrap;
}

/* ---------- sign-in ---------- */
/* One card, one field, and no chrome around it: the only decision on this page is whether you
   have the password. It is deliberately not dressed up as a product landing page — everyone
   who reaches it is an operator who came here to read an incident. */
.signin {
  max-width: 25rem; margin: var(--sp-10) auto;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: var(--sp-8);
}
.signin h1 { font-size: var(--fs-lg); }
.signin-lede { color: var(--text-dim); font-size: var(--fs-sm); margin: 0 0 var(--sp-6); }
.signin-form { display: flex; flex-direction: column; gap: var(--sp-2); }
.signin-form label {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
}
.signin-form input {
  font: inherit; color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--r-sm); padding: var(--sp-3); width: 100%;
}
.signin-form button {
  font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  background: var(--accent); color: var(--on-accent); border: 0;
  border-radius: var(--r-sm); padding: var(--sp-3) var(--sp-4); margin-top: var(--sp-4);
}
/* The one message on this dashboard that is an error rather than a row's state, so it wears
   the tint a critical row wears in the tables. */
.formerror {
  background: var(--tint-critical); color: var(--critical);
  border-radius: var(--r-sm); padding: var(--sp-3);
  font-size: var(--fs-sm); margin: 0 0 var(--sp-5);
}
/* Sign out is weighted like a nav link rather than a button: it is an exit, and the only
   emphasised control in this stylesheet should be the one that gets you in. */
form.signout { display: flex; align-items: center; margin-left: var(--sp-5); }
form.signout button {
  font: inherit; font-size: var(--fs-sm); font-weight: 550; cursor: pointer;
  color: var(--text-dim); background: none; border: 0; padding: var(--sp-2) 0;
}

/* ---------- prose ---------- */
/* The RCA is the only thing on this dashboard a machine WROTE rather than measured, and it
   is the reason anyone opens an incident. Setting it in a serif at a reading measure is the
   whole type system in one line: it is an argument to be read, not a field to be scanned. */
/* Frame and measure are two different jobs, so they are two elements. The frame spans the
   content width and lines up with the tables above and below it; the text inside stops at a
   readable 68ch. Putting both on one element made the card end in mid-air two-thirds across
   the page, aligned with nothing, which reads as a rendering bug rather than as typography. */
.prose {
  background: var(--surface); border: 1px solid var(--border);
  border-left: var(--spine-w) solid var(--border-strong);
  border-radius: var(--r); padding: var(--sp-6);
}
.prose-text {
  font-family: var(--font-prose); font-size: var(--fs-md); line-height: 1.7;
  max-width: 68ch; white-space: pre-wrap; overflow-wrap: break-word; text-wrap: pretty;
}

/* ---------- empty, pager ---------- */
.empty {
  border: 1px dashed var(--border-strong); border-radius: var(--r);
  padding: var(--sp-10) var(--sp-6); text-align: center; color: var(--text-dim);
  font-size: var(--fs-sm);
}
.empty strong {
  display: block; color: var(--text); font-size: var(--fs-md);
  font-weight: 600; letter-spacing: -.01em; margin-bottom: var(--sp-2);
}
.pager {
  display: flex; gap: var(--sp-3); align-items: center;
  margin-top: var(--sp-5); font-size: var(--fs-sm);
}
.pager a {
  text-decoration: none; font-weight: 550;
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  padding: var(--sp-2) var(--sp-3); background: var(--surface);
}
.pager .at { margin-left: auto; color: var(--text-dim); font-family: var(--font-data); }
.title-meta { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; margin: 0 0 var(--sp-6); }

/* ---------- charts ---------- */
.chart { width: 100%; height: auto; display: block; overflow: visible; }
.chart-bar { fill: var(--text-dim); }
/* The last bar is the week in progress. Marking it is information, not decoration: without it
   the final column always reads as a collapse in incident volume. Drawn as an OUTLINE rather
   than in the accent colour — a saturated bar draws the eye to the one number that is not yet
   true, and an unfilled box is the shape of a count still being filled in. */
.chart-bar-current { fill: none; stroke: var(--text-dim); stroke-width: 1.5; stroke-dasharray: 3 3; }
.chart-rule { stroke: var(--border); stroke-width: 1; }
.chart-rule-soft { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 4; }
.chart-label, .chart-empty { fill: var(--text-dim); font-family: var(--font-data); font-size: 10px; }
.chart-value { fill: var(--text-dim); font-family: var(--font-data); font-size: 10px; font-weight: 600; }
.chart-empty { font-size: 12px; }

/* ---------- topology ---------- */
/* Every box is drawn on the SAME fill, so there is exactly one text-on-background pair in the
   whole figure (--text on --surface: 17.82:1 light, 14.58:1 dark) and no group's colour can
   break label legibility.

   An earlier revision coloured the boxes by ROLE — blue inbound, green outbound, red backends.
   It was pretty and it lied. Red means "critical" on every other page of this dashboard, so a
   perfectly healthy backend read as a broken one; green implied a health check this page never
   performs (design 4.3: nothing here is probed, it is config read back). Role is already
   carried by position — three labelled columns and two labelled clusters — which leaves the
   stroke free for the only two things in this figure that are actually STATE. Each clears the
   3:1 that a non-text graphic needs against that one fill:
     --warning  not configured                                    3.85 light / 5.79 dark
     --accent   reached over SQS via llm-worker (design 4.2, the
                one fact the diagram exists to make obvious)      6.17 / 8.49
   Everything else is --border-strong. The agent's own box is --text at 2.5px: the subject of
   the map earns weight, not hue. (.topo-in / .topo-out / .topo-backend / .topo-capability carry
   no rule of their own by design — they are structural hooks, and giving them a colour is the
   mistake above. A tool family especially: the agent knows the server ADVERTISED it, not that
   calling it works, so any colour there would be a health claim the page cannot make.) */
.topo { display: block; }
.topo-dot { fill: var(--border); }
.topo-cluster { fill: none; stroke: var(--border); stroke-width: 1; stroke-dasharray: 5 5; }
.topo-box { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1.5; }
.topo-label { fill: var(--text); font-family: var(--font-ui); font-size: 11.5px; font-weight: 550; }
.topo-sub { fill: var(--text-dim); font-family: var(--font-data); font-size: 9.5px; }
.topo-backend-worker { stroke: var(--accent); stroke-width: 2; }
.topo-self { stroke: var(--text); stroke-width: 2.5; }
/* A dependency the agent cannot actually reach. Dashed as well as coloured, so the state
   survives a greyscale print and does not rest on hue alone. */
.topo-off { stroke: var(--warning); stroke-dasharray: 4 3; }
.topo-off + .topo-label { fill: var(--text-dim); }
/* Immediate-sibling only. topologyDiagram() emits every <rect>/<text> as flat siblings of
   <svg> (no per-row <g>), so the general-sibling combinator (~) would match every later
   .topo-label in the document, not just this box's own — that once made most of the
   diagram's text unreadable. box() always emits a label as the very next sibling of its own
   rect, so "+" alone is correct and sufficient. */
.topo-self + .topo-label { font-weight: 650; letter-spacing: -.01em; }
.topo-edge { stroke: var(--border-strong); stroke-width: 1.5; fill: none; }
.topo-edge-soft { stroke: var(--border-strong); stroke-width: 1.5; fill: none; stroke-dasharray: 4 4; }
.topo-arrow { fill: var(--border-strong); }
.topo-band {
  fill: var(--text-dim); font-family: var(--font-data); font-size: 9.5px;
  font-weight: 600; letter-spacing: .12em;
}

/* ---------- topology: scale and navigation ---------- */
/* Zoom without script. The radios are visually hidden but still focusable and still hit by
   their <label>, and :checked drives the SVG's width — vector, so every step stays sharp
   instead of resampling a bitmap. Pan is the container's own scrollbar: horizontal here,
   with the page taking the vertical, which needs no magic max-height to guess at. */
.topo-z { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.topo-bar {
  display: flex; gap: var(--sp-2); justify-content: flex-end;
  padding: var(--sp-3) var(--sp-4) 0;
}
.topo-bar label {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: .08em; color: var(--text-dim);
  padding: .35em .7em; border-radius: var(--r-sm); border: 1px solid transparent;
  cursor: pointer; user-select: none;
}
#topo-z1:checked ~ .topo-bar label[for="topo-z1"],
#topo-z2:checked ~ .topo-bar label[for="topo-z2"],
#topo-z3:checked ~ .topo-bar label[for="topo-z3"] {
  color: var(--text); border-color: var(--border-strong); background: var(--surface-2);
}
/* The radio is off-screen, so its focus ring would be too. Painting it on the label instead
   is what keeps the control keyboard-visible rather than merely keyboard-reachable. */
#topo-z1:focus-visible ~ .topo-bar label[for="topo-z1"],
#topo-z2:focus-visible ~ .topo-bar label[for="topo-z2"],
#topo-z3:focus-visible ~ .topo-bar label[for="topo-z3"] {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
.topo-view { overflow-x: auto; }
.topo-view .topo { width: 100%; }
#topo-z2:checked ~ .topo-view .topo { width: 160%; }
#topo-z3:checked ~ .topo-view .topo { width: 240%; }

/* ---------- topology: live pan and zoom ---------- */
/* Every rule here hangs off [data-live], which only topology-script.ts sets — and it sets it
   after removing the radios above, so the two control sets can never both be on screen. With
   the script blocked by the CSP or scripting off, none of this applies and the three-step
   scale is still exactly what the page has. */
.topo-tools { display: none; }
.topo-frame[data-live="on"] .topo-tools {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4) 0;
}
/* auto on the right margin, so the controls stay pinned where the radio bar had them and the
   hint fills the space they left rather than pushing them around. */
.topo-hint {
  margin: 0 auto 0 0; color: var(--text-dim);
  font-size: var(--fs-2xs); letter-spacing: .01em;
}
.topo-tools button {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: .08em; color: var(--text-dim);
  background: none; border: 1px solid transparent; border-radius: var(--r-sm);
  padding: .35em .7em; cursor: pointer; line-height: 1;
}
.topo-tools button[data-zoom="reset"] { margin-left: var(--sp-2); }
/* tabular-nums and a floor on the width: without both, the toolbar shifts sideways on every
   wheel notch as the readout goes 100% -> 137% -> 800%. */
.topo-level {
  font-family: var(--font-data); font-size: var(--fs-2xs); color: var(--text-dim);
  min-width: 3.6em; text-align: center; font-variant-numeric: tabular-nums;
}
.topo-tools button[aria-disabled="true"] { opacity: .4; }
/* touch-action: pan-y hands one-finger vertical drags back to the browser. Without it the map
   is a hole in the page on a phone: the reader's thumb pans the diagram and the article it
   sits in never scrolls again. Horizontal is ours — it is the axis the map overflows on. */
.topo-frame[data-live="on"] .topo-view { overflow: hidden; cursor: grab; touch-action: pan-y; }
.topo-frame[data-drag="on"] .topo-view { cursor: grabbing; }

/* Every box in the map is a link to its own row in the tables below. No colour and no
   underline: the boxes already read as objects, and decorating a hundred of them would undo
   the restraint the rest of the figure is built on. Hover moves the FILL, never the stroke —
   the stroke is where this figure keeps its two state signals, and a hover that repainted it
   would erase "not configured" for as long as the pointer sat there. Focus needs no rule at
   all: the global :focus-visible outline renders on an SVG <a> like any other element, and
   an outline sits outside the box instead of overwriting anything inside it. */
.topo-link { cursor: pointer; }
/* :target on the far end is what confirms the trip landed. An outline again, for the same
   reason: --spine already carries the row's severity, and borrowing it here would swap a
   permanent signal for a transient one. */
tbody tr:target { outline: 2px solid var(--accent); outline-offset: -2px; }
/* scroll-margin, not a scroll handler: an anchor jump would otherwise park the row under the
   sticky header. The value is the header's height plus a line of air. */
tbody tr:target td { scroll-margin-top: 5rem; }

/* The tool list a family expands into. Bare list, no bullets: these are identifiers, and a
   bullet column would only push them off the mono grid they line up on. */
details > summary { cursor: pointer; font-weight: 550; }
details > summary > span { margin-left: .35em; }
ul.toollist {
  /* indented to the family name, not to the triangle: the names hang under the thing they
     belong to, which is the only hierarchy this list has to show. */
  list-style: none; margin: var(--sp-3) 0 var(--sp-2); padding-left: 1.15em;
  display: flex; flex-direction: column; gap: var(--sp-2);
}
ul.toollist li { color: var(--text-dim); overflow-wrap: anywhere; }

/* ---------- hover ---------- */
/* Pointer-only, all of it. See the note beside the base link rule: a touch device latches
   :hover on the last thing tapped, so these are states a phone can enter but never leave. */
@media (hover: hover) {
  .topo-bar label:hover { color: var(--text); border-color: var(--border); }
  .topo-tools button:not([aria-disabled="true"]):hover { color: var(--text); border-color: var(--border); }
  .topo-link:hover .topo-box { fill: var(--surface-2); }
  a:hover { text-decoration-color: var(--accent); }
  h2 a:hover { text-decoration: underline; }
  header.top nav a:hover { color: var(--text); }
  tbody tr:hover { background: var(--surface-2); }
  form.filters button:hover, .signin-form button:hover { filter: brightness(1.1); }
  form.signout button:hover { color: var(--text); }
  .pager a:hover { border-color: var(--accent); color: var(--accent); }
  .chart-bar:hover { fill: var(--text); }
  .chart-bar-current:hover { fill: none; stroke: var(--text); }
}

/* ---------- responsive & motion ---------- */
/* iOS Safari zooms the whole page in when you focus an input set below 16px, and it does not
   zoom back out. The filter row is 13px by design on a desktop; on a touch device the field
   text goes to 16px so tapping "Namespace" does not throw the layout off-screen. */
@media (pointer: coarse) {
  form.filters input, form.filters select, .signin-form input { font-size: 16px; }
}
@media (max-width: 46rem) {
  :root { --gutter: max(var(--sp-4), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px)); }
  main { padding: var(--sp-6) var(--gutter) var(--sp-10); }
  header.top { gap: var(--sp-4); }
  header.top nav { gap: var(--sp-4); }
  footer.bottom { padding: 0 var(--gutter) var(--sp-8); }
  .hero { padding: var(--sp-5) var(--sp-5) 0; }
  .hero-body { grid-template-columns: minmax(0, 1fr); gap: var(--sp-5); align-items: start; }
  .hero .stat, .hero .stat + .stat { padding-left: 0; border-left: 0; }
  .hero .stat + .stat { border-top: 1px solid var(--border); }
  .prose { padding: var(--sp-4); }
  /* An SVG scales with its viewBox, so a 10px caption in a 720-unit chart renders near 4px on
     a phone. The per-bar counts go — every number is in the tables below, and each bar keeps
     its <title> — which frees the top gutter and lets the period labels grow back to legible. */
  .chart-value { display: none; }
  .chart-label { font-size: 19px; }
  /* Neither half of the hint is true here: there is no cursor to drag with and no ctrl key to
     hold. The gesture a phone does have — one finger across the map — needs no instructions. */
  .topo-hint { display: none; }
}
@media (prefers-reduced-motion: no-preference) {
  a, .pager a, header.top nav a, form.filters button, .signin-form button,
  form.signout button, .topo-tools button, .chart-bar, tbody tr {
    transition: color .12s ease, background-color .12s ease, border-color .12s ease,
                fill .12s ease, text-decoration-color .12s ease;
  }
}
`;
