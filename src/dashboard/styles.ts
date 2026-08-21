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
// TWO faces, two jobs, each earned by the kind of content it carries:
//   --font-ui    the interface, and everything written in sentences
//   --font-data  what the system MEASURED — ids, endpoints, queue names, timestamps, counts
//
// There was a third — a serif reading face for the RCA, on the argument that what the agent
// WROTE is a different kind of content from what it measured. It is, and the frame around it
// already says so. What a serif said on the page was something else: none of these stacks is a
// font this project ships (font-src is blocked outright), so it resolved to Iowan Old Style or
// Times, a print face at 17px on a graphite console, with a colour and a rhythm that belong to
// no other element on the screen. The RCA read as pasted in from somewhere else. The
// distinction is still drawn — the panel, the 68ch measure and the larger size all draw it —
// just not with a face borrowed from a book.
export const STYLES = `
:root {
  color-scheme: light dark;

  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-data: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", Menlo, Consolas, monospace;

  --fs-2xs: .6875rem; --fs-xs: .75rem; --fs-sm: .8125rem; --fs-base: .9375rem;
  --fs-md: 1.0625rem; --fs-lg: 1.3125rem;
  --fs-xl: clamp(1.5rem, 1.15rem + 1.5vw, 2rem);
  --fs-hero: clamp(2.5rem, 1.6rem + 3.6vw, 3.75rem);
  /* A stat's value scales with the width of the COLUMN it sits in, not the viewport: the same
     four tiles are 300px wide on a desktop and 170px on a phone, and a figure sized for one is
     either lost or clipped in the other. cqi resolves against the nearest ancestor container
     (page, declared on main); with no container anywhere it falls back to the viewport, which
     is the old behaviour and still legible. */
  --fs-stat: clamp(1.0625rem, .9rem + .55cqi, 1.5rem);

  --sp-1: .25rem; --sp-2: .5rem; --sp-3: .75rem; --sp-4: 1rem;
  --sp-5: 1.25rem; --sp-6: 1.5rem; --sp-8: 2rem; --sp-10: 2.5rem; --sp-12: 3rem;

  --r-sm: 5px; --r: 10px; --r-lg: 14px;
  /* The content column's ceiling. It is a measure for TABLES, not for prose — the RCA and every
     other run of sentences carries its own 68ch cap, so the page can be wider than a comfortable
     line length without any line getting longer. At 76rem a 1920 display spent a fifth of itself
     on empty gutters while a six-column table scrolled inside its own frame. */
  --maxw: 88rem;
  --rail-w: 13.5rem;
  --spine-w: 3px;
  /* The page gutter, and the notch allowance folded into it: below 60rem the rail becomes a
     sticky bar across the top, so on a phone held in landscape it would otherwise run under
     the camera cutout. env() needs its own fallback — without the 0px a browser that has
     never heard of safe areas throws the whole declaration away and the page loses its
     gutter entirely. */
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
/* The rail is a grid column, not an overlay: content sits BESIDE it and never under it, so
   there is no z-index race and no scroll handler deciding when the two overlap. The single
   .skip child is out of flow and takes no cell. */
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-ui); font-size: var(--fs-base); line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  accent-color: var(--accent);
  min-height: 100vh;
  display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr);
}
/* Sign-in and the "not configured" notice render no rail at all — one column, and the
   grid has to be told, or the page opens 13.5rem short of the left edge. */
body.bare { grid-template-columns: minmax(0, 1fr); }

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
/* A rail rather than a bar across the top. Three destinations are too few to earn a menu and
   too many to keep re-reading horizontally: down the side they become a fixed spatial index —
   the same three positions on every screen, all visible at once, none of them consuming the
   vertical space the tables want. */
.rail {
  position: sticky; top: 0; align-self: start; height: 100vh;
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-3);
  background: var(--surface); border-right: 1px solid var(--border);
}
.rail .brand {
  font-family: var(--font-data); font-size: var(--fs-sm); font-weight: 600;
  letter-spacing: -.02em; padding: var(--sp-2) var(--sp-3) var(--sp-5);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rail nav { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
/* Sign out is shaped exactly like a destination and coloured exactly like one — it is the
   fourth thing in the rail and behaves as such — but it sits at the far end, held there by
   the auto margin, because leaving is not one of the places you can go. */
.rail nav a, form.signout button {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
  font-size: var(--fs-sm); font-weight: 550; white-space: nowrap;
  color: var(--text-dim); text-decoration: none;
}
/* The same mark the tables use for a row's severity, borrowed for the same job: a bar of ink
   down the leading edge saying "this one". Colour is spent here because "where am I" is the
   one question the chrome exists to answer. */
.rail nav a[aria-current="page"] {
  color: var(--text); background: var(--surface-2);
  box-shadow: inset var(--spine-w) 0 0 var(--accent);
}
/* flex-shrink 0: a long label must squeeze the text, never the glyph — a 4px-wide triangle
   is not an icon, it is a rendering fault. */
.ico { width: 18px; height: 18px; flex: 0 0 auto; }

/* min-width 0 on a grid column that holds tables: without it the column's automatic minimum
   size is its widest cell, and one long alert name widens the whole page instead of scrolling
   inside its own .table-wrap. */
.pane { min-width: 0; display: flex; flex-direction: column; }
/* The 100% width is doing real work here, not restating a default. An auto cross-axis margin
   is what centres main in the pane, and a flex item with one does not stretch — it takes its
   fit-content width instead, which on a phone is the width of the widest table, so main grew
   past the viewport and dragged the whole page into a horizontal scroll while .table-wrap sat
   there scrolling nothing. A definite width plus min-width 0 pins main to the pane and hands
   the overflow back to the wrap, where it belongs. */
/* container is what lets everything below size itself against the CONTENT column instead of
   the window. The two are not the same measurement and never were: the rail is a 13.5rem column
   above 60rem and a bar across the top below it, so a 1000px window hands main either 784px or
   1000px. A media query cannot tell those apart — it only ever sees 1000px — which is how a
   panel ends up tuned for a width it never actually gets. Named, so a container added inside a
   component later cannot silently capture a query written for this one. */
main {
  width: 100%; min-width: 0; max-width: var(--maxw); margin: 0 auto;
  padding: clamp(var(--sp-6), 3cqi, var(--sp-8)) var(--gutter) var(--sp-12);
  container: page / inline-size;
}
/* The incident page used to cap itself at 58rem — a reading measure, so a line of argument did
   not run the width of a large monitor. It is gone, deliberately: the cap applied to the whole
   PAGE, not to the prose, so above ~1180px the fact strip, both record tables and the RCA all
   froze at one width and the page stopped answering the screen at all. A measure that stops the
   figures growing to buy the sentences a shorter line is paying the wrong block. The page now
   follows the column like every other; if the RCA's line length needs a ceiling later it goes on
   the text, inside .doc, where it costs the tables nothing. */
/* A document laid out as ONE block instead of a run of loose children. Without it every strip
   in a skill page is its own full-width band sized only by its content — an eyebrow is 880x11 —
   and the page is a stack of bands rather than a document. Width comes from the column, so the
   block follows the screen at every size; the RCA's 58rem measure is deliberately NOT applied
   here, because what a skill page holds is a preformatted playbook, not sentences: wrapping it
   to a reading measure hides the right-hand half of every line the author wrote at their own
   width. min-width 0 for the same reason main needs it — the <pre> must not widen the page. */
.doc { width: 100%; min-width: 0; }

/* auto on top, 0 on the bottom: horizontally centred like main, and pushed to the foot of a
   short page rather than left floating under a two-row table. */
footer.bottom {
  width: 100%; min-width: 0; max-width: var(--maxw); margin: auto auto 0;
  padding: 0 var(--gutter) var(--sp-10);
  color: var(--text-dim); font-family: var(--font-data); font-size: var(--fs-2xs);
}

/* ---------- type ---------- */
/* overflow-wrap, because the incident page's <h1> is an alertname and an alertname is one
   unbroken CamelCase identifier: KubernetesContainerOomKiller sets 328px at this size, which
   is 40px more than a 320px screen has to give it and 24px more than the whole document had —
   the title alone was what made that page scroll sideways, tables and rail notwithstanding.
   text-wrap: balance has nothing to work with on a single word; only a break does. "anywhere"
   rather than "break-word" for the same reason the card layout takes it: it also lowers the
   heading's min-content width, so a heading inside a track that measures its content cannot
   widen that track past the screen either. */
h1 {
  font-size: var(--fs-xl); font-weight: 640; letter-spacing: -.025em; line-height: 1.15;
  margin: 0 0 var(--sp-4); text-wrap: balance; overflow-wrap: anywhere;
}
/* Section headers are instrument-panel labels: a small mono caption with a hairline running
   out to the edge of the content. Deliberately NOT numbered — these sections are a set of
   facts about one incident, not a sequence, and numbering would assert an order that is not
   there. The only place this page counts is the incident id, which is a real identifier. */
h2, .eyebrow {
  display: flex; align-items: center; gap: var(--sp-4);
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .14em; color: var(--text-dim);
  margin: clamp(var(--sp-6), 3.2cqi, var(--sp-8)) 0 var(--sp-4);
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
/* The glyph and the label it labels are one unit, so they get their own gap: h2's is the
   distance out to the hairline, and at 16px between a picture and its word the two read as
   separate items. No colour of their own — they inherit the caption's dim, because a section
   marker is orientation, not signal. */
.sec { display: flex; align-items: center; gap: var(--sp-2); }
h2 .ico, .stat dt .ico { width: 15px; height: 15px; }
/* flex-start, not center: a stat label wraps to two lines in a narrow column, and centring
   would float the glyph into the gutter between them instead of marking where the label
   starts. On the common one-line case the two are the same to within a fraction of a pixel. */
.stat dt { display: flex; align-items: flex-start; gap: var(--sp-2); }
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
   the 30-day count set against the weekly series it summarises. The count and its shape are
   one fact and belong in one frame — and nothing else does, which is why the supporting
   figures moved out to their own section rather than sitting on a shelf inside this one. */
.hero {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: clamp(var(--sp-5), 2.6cqi, var(--sp-6));
  overflow: hidden;
  container: hero / inline-size;
}
/* A PROPORTION, not a fixed column plus whatever is left. auto sized the first column to the
   width of the digits — so a 3-digit count took a third of the frame and a 1-digit count took a
   tenth, and the chart's shape changed every time the number did. A percentage floor keeps the
   split the same at every count and every width; the minmax floor stops it collapsing under the
   count itself. Centred rather than bottom-aligned: the count is one short block against a tall
   one, and aligning their baselines left the whole band above the number empty. */
.hero-body {
  display: grid; grid-template-columns: minmax(6rem, 16%) minmax(0, 1fr);
  gap: clamp(var(--sp-5), 3cqi, var(--sp-8)); align-items: center;
}
.hero-figure {
  margin: 0; display: flex; flex-direction: column; gap: var(--sp-3);
  justify-content: center;
}
.hero-value {
  font-size: var(--fs-hero); font-weight: 620; letter-spacing: -.045em; line-height: .92;
  font-variant-numeric: tabular-nums;
}
.hero-unit {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .14em; color: var(--text-dim);
}
.hero-chart { min-width: 0; }
/* One column, and the count stops being a headline set beside a chart — it becomes a caption
   over one. Under about 30rem of frame the two-column split gives the chart too little width to
   read twelve periods in. */
@container hero (max-width: 30rem) {
  .hero-body { grid-template-columns: minmax(0, 1fr); gap: var(--sp-5); align-items: start; }
  .hero-figure { flex-direction: row; align-items: baseline; gap: var(--sp-3); }
}

/* One stat shelf, three homes: the overview's summary panel, its token totals, and the incident
   fact bar. They are the same kind of thing — a labelled value — so they are one component.
   The dividers are a 1px grid gap with the border colour showing through from behind, not a
   border on each cell. A per-cell border cannot know it is at the start of a wrapped row —
   five stats in a four-wide grid left the fifth with a rule on the wrong side and none above
   it. The gap draws every divider the grid actually has, in both directions, and no others.

   FOUR, then two, then one — an explicit ladder, not auto-fit. auto-fit divides by whatever
   fits and lands on three as often as not, which leaves a four-item row as 3 + 1: one tile
   alone on a second row, reading as a category of its own rather than the fourth of four. The
   ladder only ever halves, so every row stays full at every width. Every shelf on the page is
   built to exactly four items to keep that promise. Queried against page — the content column,
   not the window — because the rail's width is not the panel's to spend. */
.stats {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px; margin: 0; background: var(--border);
  border: 1px solid var(--border); border-radius: var(--r); overflow: hidden;
}
@container page (max-width: 54rem) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container page (max-width: 26rem) { .stats { grid-template-columns: minmax(0, 1fr); } }
/* The incident page's shelf carries identity, not figures: a namespace, a confidence, two
   timestamps. At the bottom of the ladder the four tiles stack, and four stacked tiles are a
   third of a phone screen spent above the analysis a reader opened the page for. So on this
   variant the stacked tile lays its caption and value on ONE line — label left, value right,
   the shape of a spec sheet. Only in the one-column step: two abreast there is no room for it,
   and above that the tiles are already short. */
@container page (max-width: 26rem) {
  .stats.facts .stat { flex-direction: row; align-items: baseline; justify-content: space-between; gap: var(--sp-4); }
  .stats.facts .stat dd { margin-top: 0; font-size: var(--fs-base); text-align: right; }
}
/* A column with the value pushed to the FLOOR of the tile by margin-top:auto. Grid stretches
   every tile in a band to the same height, so a value anchored to the bottom lands on the same
   line as its neighbours whether or not its caption wrapped — a row of figures that do not line
   up is a row that has to be read one tile at a time. Anchoring to the bottom rather than
   reserving a second caption line everywhere is the difference between alignment and a blank
   line in every tile on the page. It does mean the sub-line is part of what is anchored, so
   within one shelf the figures either all carry a sub or none do; statList's callers keep to
   that, and views.test.ts holds them to it. */
.stat {
  padding: clamp(var(--sp-4), 1.6cqi, var(--sp-5)) clamp(var(--sp-4), 1.6cqi, var(--sp-5));
  background: var(--surface); min-width: 0;
  display: flex; flex-direction: column; gap: var(--sp-2);
}
/* The same severity bar the tables use, on the one tile where a number means something is
   wrong. Only tiles that declare a tone get it — see the [data-tone] block under tables. */
.stat[data-tone] { box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent); }
.stat dt {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim);
  line-height: 1.4;
}
.stat dd {
  margin: 0; margin-top: auto; font-size: var(--fs-stat); font-weight: 600;
  letter-spacing: -.015em; font-variant-numeric: tabular-nums; line-height: 1.2;
  overflow-wrap: anywhere;
}
.stat dd span {
  display: block; font-size: var(--fs-xs); font-weight: 400;
  letter-spacing: 0; color: var(--text-dim); margin-top: 2px;
}

/* ---------- tables ---------- */
/* Same treatment as the log excerpt, for the tables that stay tabular on purpose (the MCP tool
   list): where the platform draws a bar, it is a hairline in this palette rather than the
   light default one across the foot of a dark panel. Where nothing overflows there is no bar
   and this costs nothing. */
.table-wrap {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r); overflow-x: auto;
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
}
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; white-space: nowrap;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
  padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border);
}
/* Except on a record table, where the header row is what makes it too wide. A nowrap <th> is
   a floor under its column that the column's own values never asked for: "Confirmed root
   cause" is 20 characters of tracked-out uppercase, and five of those floors added up put the
   remediation and feedback tables 74px past their wrapper at a 700px window — a sideways
   scroll that hides Executed and When, which is where the outcome of a change is written.
   A scan-list keeps its nowrap: there the header IS the column, and one wrapped to two lines
   would break the single line of captions a reader runs their eye along. */
table[data-stack] th { white-space: normal; }
td { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }

/* The signature, and the whole point of holding colour back everywhere else: a row's
   severity is a solid bar of ink down its leading edge. It is set through a custom property
   rather than one rule per severity, so a row opts in by naming a tone and nothing else. */
tbody td:first-child {
  box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent);
  padding-left: calc(var(--sp-4) + var(--spine-w));
}
/* Not scoped to tr any more: naming a tone is the page's one severity vocabulary, and a stat
   tile carrying a count of open incidents means the same thing by it as a row does. The property
   only draws where something consumes it (the first cell of a row, a toned tile), so declaring
   it on a badge as well costs nothing. */
[data-tone="critical"] { --spine: var(--critical); }
[data-tone="warning"]  { --spine: var(--warning); }
[data-tone="info"]     { --spine: var(--info); }
[data-tone="ok"]       { --spine: var(--ok); }
td .sub { color: var(--text-dim); font-size: var(--fs-sm); margin-top: 2px; overflow-wrap: anywhere; }
/* The alert name is the row's only target, and at 15px/1.55 its line box is 23px — a whisker
   under the 24px a finger needs. Padding on an inline element grows the hit area without
   touching the line box, so the row stays exactly as tall as it looks. */
td.primary a { font-weight: 550; padding-block: 3px; }

/* ---------- the incident table, below 46rem ---------- */
/* Five columns do not fit a phone, and .table-wrap's answer — scroll sideways — was the wrong
   one here: what fell off the right edge was severity and state, the two things a reader opens
   this page to triage by, behind a scrollbar with no affordance pointing at it. Under 46rem the
   row stops being a row and becomes a card: a quiet header of timestamp and badges, then the
   alert name and its cause across the full width, then the namespace. Nothing is hidden,
   nothing needs discovering, and the columns come back the moment there is room.
   Scoped to [data-cards] because the placement is by cell name — the remediation and feedback
   tables have different columns and would come apart under these rules. */
@container page (max-width: 46rem) {
  table[data-cards] thead { display: none; }
  table[data-cards] tbody tr {
    display: grid; grid-template-columns: minmax(0, 1fr) max-content max-content;
    gap: var(--sp-2) var(--sp-3); align-items: baseline;
    padding: var(--sp-4); border-bottom: 1px solid var(--border);
    /* the spine moves with the layout: it belonged to the first CELL, and the first cell is no
       longer the leading edge of anything once the row is two-dimensional. */
    box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent);
  }
  table[data-cards] tbody tr:last-child { border-bottom: 0; }
  table[data-cards] tbody td { padding: 0; border-bottom: 0; box-shadow: none; }
  /* Header line: when the incident fired, and the two badges hard against the right edge. The
     timestamp holds the 1fr track, so the badges keep the same rag down the whole list — beside
     a title they would step left and right with every alert name and stop being a column to
     scan.
     The timestamp gives up its nowrap here. In a column it is one atom, but on this line it is
     the only thing that can yield: the badges are max-content and the track under it is
     minmax(0,1fr), so a nowrap timestamp does not shrink the track, it overflows it and prints
     under CRITICAL. Wrapping happens at its own space, so the worst case is the date over the
     time — which only ever happens near 320px. */
  table[data-cards] td.when  { grid-column: 1; grid-row: 1; white-space: normal; }
  table[data-cards] td.sev   { grid-column: 2; grid-row: 1; }
  table[data-cards] td.state { grid-column: 3; grid-row: 1; }
  /* The name and its cause take the whole card. Beside the badges the cause had a third of the
     width and ran to four lines with the space under the badges left empty — the same sentence
     fits two lines here, so more of the list is on screen at once.
     overflow-wrap: anywhere, not break-word — only anywhere also lowers the cell's min-content
     width, and a spanning item still pushes on the tracks it spans. An alert name is one
     unbreakable identifier; breaking it beats widening the card into a sideways scroll. */
  table[data-cards] td.primary {
    grid-column: 1 / -1; grid-row: 2; min-width: 0; overflow-wrap: anywhere;
  }
  /* The namespace closes the card on the same right edge the badges opened it on. It never
     wraps: it is a label, and a label broken across two lines reads as two of them. */
  table[data-cards] td.ns {
    grid-column: 1 / -1; grid-row: 3; justify-self: end; max-width: 100%;
    font-size: var(--fs-sm); color: var(--text-dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
}

/* ---------- every other table, below 46rem ---------- */
/* The same problem, answered generically. Remediation, on-call feedback and the RCA's Evidence
   are records of three to five fields; as columns on a phone their last fields — Result,
   Executed, Outcome, Source — sit past the right edge, and on a remediation table that means
   what you cannot see is whether the change worked. Each cell becomes its caption and its
   value. The caption comes from the cell's own data-label, so this block names no column and
   holds for all three tables and for any fourth.
   Caption ABOVE the value, not beside it: beside it, the widest label in the table sets a
   column ("Confirmed root cause" is 20 characters) and every value in the record is read
   through what is left. Taller, and every field legible at 320px.

   46rem, the same number the incident list turns into cards at — one width for "a table stops
   being a table", not two. It was 40rem, and 40rem was measured against nothing: a five-field
   record does not fit five columns until about 39rem of content, so between 40 and 46rem the
   wrapper answered with the sideways scroll this block exists to avoid. The remaining margin
   is real rather than nominal — with the header row wrapping (see table[data-stack] th) the
   widest of these tables asks for ~625px against the 736px this threshold hands it, and what
   sets that floor is the handful of cells that cannot wrap at all: an action name, a Slack
   user id, a timestamp, a badge. */
@container page (max-width: 46rem) {
  table[data-stack], table[data-stack] tbody { display: block; }
  table[data-stack] thead { display: none; }
  table[data-stack] tbody tr {
    display: block; padding: var(--sp-4); border-bottom: 1px solid var(--border);
    box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent);
  }
  table[data-stack] tbody tr:last-child { border-bottom: 0; }
  /* display: block, not grid. These cells hold inline markup — inlineMrkdwn() emits <code> and
     <strong> inside a sentence — and a grid would make each of those its own item and take the
     sentence apart word by word. */
  table[data-stack] tbody td {
    display: block; padding: 0; border-bottom: 0; box-shadow: none; overflow-wrap: anywhere;
  }
  table[data-stack] tbody td + td { margin-top: var(--sp-3); }
  table[data-stack] tbody td::before {
    content: attr(data-label); display: block; margin-bottom: 2px;
    font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
    text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
  }
  /* A timestamp is nowrap so it cannot be split across a column boundary; on its own line
     there is no boundary to split at, and nowrap only lets it overflow the card. */
  table[data-stack] td.when { white-space: normal; }

  /* The same stack with the caption BESIDE the value, for a record whose values are all short —
     a backend name, a model id, four counts; an alert name, a namespace, a count, a date. There
     the caption line above says nothing the caption itself does not, and it doubles the height
     of the table: six fields become twelve lines, five times over.
     A hanging indent, not a grid or a flex row. Either of those makes every inline child its own
     item and takes a sentence apart word by word — the reason the stacked cell is display: block
     in the first place. text-indent pulls the caption left into the cell's own padding on the
     first line only, so a value that wraps continues at the padding edge and the column holds.
     The width is set for the longest caption these tables carry (REACHED VIA), not for the longest
     one imaginable; a table whose labels are sentences takes the plain stack above. */
  table[data-pairs] tbody td { padding-left: 6rem; text-indent: -6rem; }
  /* text-indent inherits, and it re-applies in every descendant that lays out its own lines. A
     badge is display: inline-block, so it took the -6rem too and printed its own text six rems
     to the left of itself — on top of the caption, leaving an empty pill behind. An inline
     element has no first line of its own and ignores this, so resetting it on every descendant
     costs nothing and catches the next inline-block a cell is given. */
  table[data-pairs] tbody td * { text-indent: 0; }
  /* No padding on this box: the universal reset at the top of this sheet does not match
     pseudo-elements, so a padding here would be added OUTSIDE the 6rem and push the first line
     past the indent while wrapped lines kept it. The gap is what is left of 6rem after the
     longest caption. */
  table[data-pairs] tbody td::before {
    display: inline-block; width: 6rem; margin-bottom: 0; text-indent: 0;
  }
  table[data-pairs] tbody td + td { margin-top: var(--sp-2); }
}

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
/* Six fields sized to what they hold, not to each other. auto-fit used to divide the row into
   equal tracks, which gave a date field that can only ever say dd/mm/yyyy the same width as an
   alert name, and re-cut the row at every width — 6 across here, an orphaned 4+3 there, with
   Apply landing wherever the wrap dropped it. The tracks are declared instead, and the ladder
   is a fixed 3-step one like the stat shelf. Both steps divide six evenly, which is the point:
   from/to is one range and severity/state is one pair of enums, and on 6, 3 or 2 columns each
   lands beside its partner instead of across a row break. */
form.filters {
  display: grid;
  grid-template-columns: 9.5rem 9.5rem minmax(0, 1fr) minmax(0, 1fr) 8.5rem 8.5rem auto;
  gap: var(--sp-3) var(--sp-3); align-items: end; margin: var(--sp-6) 0;
}
@container page (max-width: 62rem) {
  form.filters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  form.filters .actions { grid-column: 1 / -1; }
}
@container page (max-width: 34rem) {
  form.filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
form.filters label {
  display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
}
/* One height for all three control types, and it is load-bearing rather than cosmetic. A date
   input carries a picker button, a select carries a chevron, and a text input carries neither,
   so each has a different intrinsic height; align-items: end then lined up their BOTTOMS and
   left the captions above them on three different baselines. Declaring the height once puts
   every caption and every control on the same two lines. */
form.filters input, form.filters select {
  font: inherit; font-family: var(--font-ui); font-size: var(--fs-sm);
  text-transform: none; letter-spacing: 0; color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--r-sm); padding: 0 var(--sp-3); min-width: 0; width: 100%;
  height: 2.5rem; line-height: normal;
}
form.filters input::placeholder { color: var(--text-dim); opacity: .8; }
form.filters .actions { display: flex; gap: var(--sp-4); align-items: center; height: 2.5rem; }
form.filters button {
  font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  background: var(--accent); color: var(--on-accent); border: 0;
  border-radius: var(--r-sm); padding: 0 var(--sp-5); height: 2.5rem; white-space: nowrap;
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
   emphasised control in this stylesheet should be the one that gets you in. The shape comes
   from the .rail nav a rule it shares a selector with; this adds only what a <button> needs
   to stop looking like one. */
form.signout { display: flex; margin-top: auto; }
form.signout button {
  font-family: inherit; line-height: inherit; cursor: pointer; text-align: left;
  width: 100%; background: none; border: 0;
}

/* ---------- prose ---------- */
/* The RCA is the only thing on this dashboard a machine WROTE rather than measured, and it
   is the reason anyone opens an incident. Setting it in a serif at a reading measure is the
   whole type system in one line: it is an argument to be read, not a field to be scanned. */
/* Unframed on purpose. This page renders the same RCA the agent posts to Slack, and there it
   is a message: a bold label, then the text under it, section after section. A panel around
   each one turned that into six boxes, and a box has to be as wide as its widest neighbour
   while the text inside it stops at 68ch — which is where the empty strip down the right of
   every paragraph came from. Removing the frame removes the strip: what is left of the width
   is page margin, which is what a document does with it.
   The heading is what marks a section now, and it is enough — it outranks the prose by a step
   of the scale, and nothing else on the page is set at that size. */
.prose { margin: 0; }
/* The UI face, one step up in size with an open line-height. That is what makes this read as
   prose — a paragraph is prose because of its size and its leading, not because of its serifs.
   The measure is NOT set here, and a 68ch cap was tried and taken back out. It does shorten the
   line — a measured 728px at every width — but the section rule above each paragraph belongs to
   the DOCUMENT and keeps the column, so the two ends stop in different places: at 1920 the rule
   ran to x=1748 while the text ended at x=1116, leaving 632px of hairline over nothing (448px at
   1440; gone by 1024). That is the same ragged right the panels used to produce, moved from the
   frame to the divider and made worse by the wider column. One right edge, or none. */
.prose-text {
  font-family: var(--font-ui); font-size: var(--fs-md); line-height: 1.7;
  margin: 0; white-space: pre-wrap; overflow-wrap: break-word; text-wrap: pretty;
}
/* One rule for every adjacency inside the card, because rca.ts can emit them in any order: a
   paragraph after a log excerpt is as ordinary as one before it, and the pair that used to be
   listed by name (prose + prose, prose + list, prose + code) left the other direction with no
   space at all. The margin is smaller than the empty line it replaces — an empty line is a
   whole 1.7 leading, which at a 68ch measure reads as a gap between sections rather than
   between paragraphs. */
.prose > * + * { margin-top: var(--sp-4); }

/* ---------- RCA ---------- */
/* The RCA arrives as one string and comes apart into the sections its template declares, so
   these headings sit a level below the page's own. They deliberately do NOT repeat the h2
   treatment: a second rank of mono captions with hairlines would read as a second page rather
   than as the inside of one section. Sentence case, UI face, no rule.
   The size is the correction: at --fs-base these were 15px over a 17px paragraph — a heading
   SMALLER than the text it heads, which is why the five sections read as one undifferentiated
   run no matter how much air went between them. --fs-lg is the next step in the scale and the
   first one that outranks the prose; nothing else on the incident page is at that size, so it
   also cannot be mistaken for the h1. Weight comes down as size goes up (620 -> 600): a heading
   this size no longer needs to shout, and 620 at 21px reads as a system alert.
   Space is asymmetric on purpose — 2rem above, .75rem below. A heading belongs to what follows
   it, and the gap that says so is the difference between the two, not the size of either. */
/* No width of its own. The RCA takes the column the page gives it, which is the same column the
   fact strip and the section rules above it take — a block that stops short of the panel over it
   reads as a rendering fault, however well-measured the number behind it is. The measure is the
   PAGE's instead (.doc, which takes the column), so there is exactly one width on this page and
   nothing for a second number to drift from. */
.rca-head {
  font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.02em; line-height: 1.25;
  margin: 0 0 var(--sp-3); text-wrap: balance;
}
/* What separates one section from the next, now that no panel does. The rule is the hairline
   already used between records elsewhere on the page, and the space around it is asymmetric in
   the same direction the heading's is: more above the rule than below it, so the divider reads
   as belonging to the section it opens rather than floating between two. Slack separates these
   with a blank line and nothing else; a blank line is not available to a page that has already
   spent its vertical rhythm on paragraphs, so the rule stands in for it. */
.rca-sec + .rca-sec { margin-top: var(--sp-7); padding-top: var(--sp-6); border-top: 1px solid var(--border); }
/* A section that opens with a sentence and then tabulates (renderBody's lead) is the one
   adjacency in the RCA that no heading separates: the last line of the lead and the table's
   header row would otherwise sit a single line apart and read as a caption the table swallowed. */
.rca-sec > .prose + .table-wrap { margin-top: var(--sp-5); }
/* Severity and Confidence are stated inline in the RCA text, and the model writes a sentence
   after the confidence level that exists nowhere else — the incidents table has the level and
   not the reasoning. So they are rendered, and rendered small: the badges at the top of the
   page are where those values are read, this is where they are explained. */
.rca-fields {
  display: flex; flex-wrap: wrap; gap: var(--sp-3) var(--sp-6);
  margin: 0 0 var(--sp-5);
}
.rca-fields > div { display: flex; gap: var(--sp-3); align-items: baseline; min-width: 0; }
.rca-fields dt {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim); white-space: nowrap;
}
/* Not --fs-sm: the value beside Confidence is not a value, it is the sentence in which the
   model says why — the one piece of reasoning the incidents table does not carry — and at 13px
   it was set as fine print under a heading three sizes larger. The measure is the same 68ch
   the prose takes, for the same reason: without it that sentence is one 110-character line
   across the widest frame on the page. */
.rca-fields dd { margin: 0; font-size: var(--fs-base); max-width: 68ch; min-width: 0; }
/* The same strip, promoted out of the sections that were carrying those two words in a panel
   each (see rca.ts). It trails the analysis rather than leading it, because it is the verdict
   the evidence above it earns — so it gets a rule above it and none of the leading strip's
   bottom margin. */
.rca-fields.verdicts {
  margin: var(--sp-6) 0 0; padding-top: var(--sp-5); border-top: 1px solid var(--border);
}
/* Bulleted sections the template does not name. They keep the prose setting — an unrecognised
   section is still the agent's argument — and they keep the browser's disc, which is the whole
   marker they have: classify() in rca.ts strips the source's own • when it splits the item off
   the line, so a list-style of none here would leave a stack of paragraphs at an indent with
   nothing to say where one item ends. The space between items is a third of a line rather than
   a quarter: an item that wraps has to be told apart from the item after it, and at --sp-2 the
   gap between two items was the same as the gap between two lines of one. */
.rca-list {
  font-family: var(--font-ui); font-size: var(--fs-md); line-height: 1.7;
  margin: 0; padding-left: var(--sp-5);
}
.rca-list li { margin-top: var(--sp-3); overflow-wrap: break-word; }
/* The disc is punctuation, not content: dim keeps it a marker instead of a fourth bullet-sized
   thing competing with the text beside it. */
.rca-list li::marker { color: var(--text-dim); }
.rca-list li:first-child { margin-top: 0; }
/* Log excerpts and stack traces. The one place on this page where wrapping would destroy the
   thing being read, so above the narrow step (see the container query below) it scrolls
   instead. The scrollbar declarations do not decide WHETHER a bar is drawn — that is the
   platform's call, and on macOS it is an overlay bar that appears only once something moves —
   they decide what it looks like where one IS drawn: on Windows and Linux this box would
   otherwise carry the light default bar across the bottom of a dark panel. Not verified on
   macOS: headless renders overlay bars whatever this says, so the claim stops here. */
.rca-code {
  font-family: var(--font-data); font-size: var(--fs-sm); line-height: 1.5;
  background: var(--surface-2); border-radius: var(--r-sm);
  padding: var(--sp-3) var(--sp-4); margin: 0; overflow-x: auto;
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
}
.rca-code code { font-size: inherit; }
/* One line of the excerpt, one block (rca.ts emits them). A blank line inside a stack trace
   has no text to give it height, so it needs a floor or the trace closes up by a line. */
.rca-code span { display: block; min-height: 1lh; }
/* Below the width where a log line has any chance of fitting, the scroll stops being a way to
   read: at 390px this box is 35 characters wide, and a kubelet line is 200 — six screens of
   sideways swiping to read one line, with no way to see its beginning and its end at once, on
   the device where a sideways swipe inside a vertical scroll is hardest to aim. So on the same
   step where a table stops being a table, the excerpt stops being a single line. It is a real
   loss — a wrapped line no longer shows where the next one starts — and it is the smaller one:
   the alternative is a log nobody can read at all. Above this width the line wins, which is
   why this is an override and not the default. */
@container page (max-width: 46rem) {
  .rca-code { white-space: pre-wrap; overflow-wrap: anywhere; }
  /* The hanging indent is what keeps the wrap honest: a line begins at the left edge and every
     continuation of it is inset, so three log lines still read as three. Two characters is
     enough to see and small enough that it costs the line almost nothing at 320px. */
  .rca-code span { padding-left: 2ch; text-indent: -2ch; }
}
/* A floor under the leading column, and nothing above it. The ceiling that used to sit here
   (max-width: 44ch) was inert: CSS 2.1 leaves min-width and max-width on a table cell
   undefined, and Blink honours the first and ignores the second — removing it moved no column
   by a pixel at 768, 900, 1024 or 1440. What actually balances Evidence at roughly 65/35 is
   the auto algorithm dividing the frame in proportion to what each column could use.
   The floor is for the other shape this column takes: Recommended Actions puts a horizon in
   it — one word, "Immediate" or "Short-term" — and the overflow-wrap below drops every cell's
   claim on the table's width to a single character, so that column is handed whatever the
   Action column leaves. It was handed 73px, which is narrower than the word "Immediate" and
   printed it as "Immedia/te". A dozen characters is what those two words need; a leading
   column holding sentences is far past that and never sees this declaration do anything. */
.rca td.primary { min-width: 12ch; }
/* "Cells wrap by default" is only true of prose. What the model actually puts in an evidence
   cell is a metric selector, an image digest, a pod name — one token of 60-90 characters with
   nothing in it a line may break at. A cell like that does not widen its column here, because
   the ceiling above already fixed the width: it OVERFLOWS, and a td's overflow is visible, so
   a container_memory_working_set_bytes{...} selector printed straight across the Source column
   and the tool name that backs the claim was rendered underneath it, unreadable.
   anywhere, not break-word, and the difference is the table's sizing pass rather than the line
   box: both break a word that cannot fit, but only "anywhere" also lowers what the cell CLAIMS
   as its minimum width. Leave that claim at the full ninety characters — which is what
   break-word does — and the two columns together ask for more than the frame has, so
   .table-wrap starts scrolling and the Source column is the half that goes off the edge: the
   half a reader needs to check the claim. Measured, not assumed: break-word put the Evidence
   table 300px past its own frame at 1024.
   What "anywhere" costs is that a column of one-word labels claims one character too, and that
   is what the floor on .primary above pays for. Scoped to .rca because the incident list
   breaks its alert names at CamelCase humps instead (breakable() in html.ts) — a hump is a
   better break than an arbitrary character. */
.rca td { overflow-wrap: anywhere; }
/* The template writes a tool name as _italic_ because Slack mrkdwn has no other marker for one.
   Here there is a second face, and a tool name is exactly what it is for: the thing the system
   RAN, sitting beside the argument it ran on, which the same line already puts in backticks.
   So the italic is spent on the face instead — and on weight, because a Source cell set
   entirely in one mono is a tool name and an argument with nothing but a space between them.
   Table cells only: in a paragraph an underscored word is a model emphasising a word, and that
   one keeps its italic. */
.rca td em {
  font-family: var(--font-data); font-style: normal; font-weight: 600; font-size: .92em;
}

/* ---------- skill ---------- */
/* The skill text, exactly as the model receives it. Wrapped, not scrolled — the opposite call
   from .rca-code above, and for the opposite reason: a log line is one record and breaking it
   destroys the record, while a skill body is prose the author wrapped by hand at whatever width
   their editor had. Scrolling it sideways would hide the right-hand half of every sentence
   behind a gesture, on the page whose entire purpose is reading the thing.
   pre-wrap, so the author's own line breaks and indentation survive — the numbered steps in a
   playbook are structure, and re-flowing them into a paragraph is a different document.
   The width comes from .doc, which comes from the column — nothing here declares one, so the
   block and the headings above it end on the same right edge at every screen size. */
.skill-body {
  font-family: var(--font-data); font-size: var(--fs-sm); line-height: 1.6;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r);
  padding: var(--sp-5); margin: 0;
  white-space: pre-wrap; overflow-wrap: anywhere;
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
/* An empty state that offers a way out puts it in the sentence. This is the only link that
   appears inside one, and it is the entire point of that copy — it gets the accent. */
.empty a { color: var(--accent); font-weight: 550; }

/* Where you are on the left, how to leave on the right. They wrap independently: on a phone
   the summary takes the first line and the controls the second, rather than the controls
   compressing to fit beside a sentence. */
.pager {
  display: flex; flex-wrap: wrap; gap: var(--sp-3) var(--sp-5);
  align-items: center; justify-content: space-between; margin-top: var(--sp-5);
}
.pager-count { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); }
.pager-count b {
  color: var(--text); font-weight: 600;
  font-family: var(--font-data); font-variant-numeric: tabular-nums;
}
.pages {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1);
  list-style: none; margin: 0; padding: 0;
}
/* One box, four states — link, current, dead step, ellipsis — sharing a single size, so the
   row keeps its rhythm no matter which of them a position happens to hold. tabular-nums and
   the min-width are what stop "1" and "18" from being different-sized versions of the same
   control, which makes the whole strip twitch as you page through it. */
.pages a, .pages .cur, .pages .step, .pages .gap {
  display: flex; align-items: center; justify-content: center;
  min-width: 2.25rem; height: 2.25rem; padding: 0 var(--sp-2);
  border: 1px solid transparent; border-radius: var(--r-sm);
  font-family: var(--font-data); font-size: var(--fs-sm); font-variant-numeric: tabular-nums;
  color: var(--text-dim); text-decoration: none;
}
.pages a { color: var(--text); background: var(--surface); border-color: var(--border-strong); }
/* The second and last place colour marks something other than severity: which page you are
   on. It is the "current" case the accent is reserved for — the same signal the rail carries
   down its own leading edge — and it sits below the table, far from the rows whose spines it
   would otherwise be competing with. */
.pages .cur { background: var(--accent); color: var(--on-accent); font-weight: 600; }
/* A step with nowhere to go keeps its slot and loses its affordance. Holding the position is
   the point: the arrows are what gets clicked repeatedly, and one that slides sideways when
   the last page is reached is a target that moves out from under the pointer. */
.pages .step.off { opacity: .38; }
.pages .gap { min-width: 1.5rem; padding: 0; }
.title-meta { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; margin: 0 0 var(--sp-6); }

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
/* The diagram carries its own sizing. It used to borrow .chart for this, back when the incident
   chart was one plain <svg>; .chart is now the flex wrapper around a figure whose SVG is only the
   line, and inheriting it here meant an SVG getting display:flex, a gap, and container-type:inline-size — the last of
   which contains the element's own contents out of its intrinsic sizing, so the viewBox's aspect
   ratio stopped driving the height and the whole map collapsed to the replaced-element default.
   height:auto is what lets the viewBox set the proportion; overflow:visible keeps the arrowheads
   and the outermost stroke from being clipped at the edges of the box. */
.topo { display: block; width: 100%; height: auto; overflow: visible; }
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
/* scroll-margin, not a scroll handler: below 60rem the rail is a sticky bar, and an anchor
   jump would otherwise park the row underneath it. Unconditional because the cost on a wide
   screen — where the rail is a column and overlaps nothing — is a row that lands a line lower
   than the top of the viewport, which is where you would want it anyway. */
tbody tr:target td { scroll-margin-top: 5rem; }

/* The tool list a family expands into. Bare list, no bullets: these are identifiers, and a
   bullet column would only push them off the mono grid they line up on. */
details > summary { cursor: pointer; font-weight: 550; }
details > summary > span { margin-left: .35em; }
/* A playbook is preformatted text in a table cell. Without this, one long PromQL line pushes the
   whole page sideways at 390px — a pre element does not wrap by default. */
td details > pre {
  white-space: pre-wrap;
  overflow-x: auto;
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
}
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
  .rail nav a:hover { color: var(--text); background: var(--surface-2); }
  tbody tr:hover { background: var(--surface-2); }
  form.filters button:hover, .signin-form button:hover { filter: brightness(1.1); }
  form.signout button:hover { color: var(--text); background: var(--surface-2); }
  .pages a:hover { border-color: var(--accent); color: var(--accent); }
  /* The dot grows rather than changing colour: the accent is the line's identity, and a point
     that turns a different hue on hover reads as a different KIND of point. */
  .chart-col:hover .chart-dot { transform: scale(1.5); }
  .chart-col[data-current]:hover .chart-dot { transform: scale(1.35); }
  .chart-col:hover .chart-value { color: var(--text); }
}

/* ---------- responsive & motion ---------- */
/* iOS Safari zooms the whole page in when you focus an input set below 16px, and it does not
   zoom back out. The filter row is 13px by design on a desktop; on a touch device the field
   text goes to 16px so tapping "Namespace" does not throw the layout off-screen. */
@media (pointer: coarse) {
  form.filters input, form.filters select, .signin-form input { font-size: 16px; }
  /* 44px: the floor for a target a finger has to hit. The pager especially — its controls sit
     next to each other, so an undersized one is not merely hard to hit but easy to mis-hit. */
  .rail nav a, form.signout button { min-height: 2.75rem; }
  .pages a, .pages .cur, .pages .step { min-width: 2.75rem; height: 2.75rem; }
}

/* The rail lies down. Below this width a 13.5rem column is a third of the screen spent on
   three links, so it becomes a sticky bar across the top — the same items, the same order,
   the same current-page mark rotated a quarter turn onto the bottom edge. */
@media (max-width: 60rem) {
  body, body.bare { grid-template-columns: minmax(0, 1fr); }
  .rail {
    position: sticky; top: 0; z-index: 10; height: auto; align-self: stretch;
    flex-direction: row; align-items: center; gap: var(--sp-2);
    padding: var(--sp-2) var(--gutter);
    border-right: 0; border-bottom: 1px solid var(--border);
  }
  /* Only here: the bar now has content scrolling underneath it, which is the one condition
     that makes a translucent background mean anything. The side rail never overlaps. */
  @supports (backdrop-filter: blur(1px)) {
    .rail { background: var(--glass); backdrop-filter: blur(14px) saturate(1.6); }
  }
  /* Who gives way when the bar runs out of room. Down the side there is always room; across
     the top there is not, and flex shrinks every item by its share — so the nav took a cut it
     cannot absorb (its links are nowrap, so being narrowed only makes them spill past the
     right edge and drag the whole document sideways with them) while the brand, the one item
     built to be cut, kept most of its width. Inverted here: navigation holds its size, and the
     brand absorbs the whole squeeze into the ellipsis it already has. */
  .rail .brand { padding: 0; margin-right: auto; flex: 0 1 auto; }
  .rail nav { flex-direction: row; gap: var(--sp-1); flex: 0 0 auto; }
  .rail nav a[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--accent); }
  form.signout { margin-top: 0; margin-left: var(--sp-2); flex: 0 0 auto; }
  form.signout button { width: auto; }
}
@media (max-width: 46rem) {
  :root { --gutter: max(var(--sp-4), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px)); }
  main { padding: var(--sp-6) var(--gutter) var(--sp-10); }
  footer.bottom { padding: 0 var(--gutter) var(--sp-8); }
  .rca-sec + .rca-sec { margin-top: var(--sp-6); padding-top: var(--sp-5); }
  .rca-fields > div { flex-direction: column; gap: var(--sp-1); }
  /* Neither half of the hint is true here: there is no cursor to drag with and no ctrl key to
     hold. The gesture a phone does have — one finger across the map — needs no instructions. */
  .topo-hint { display: none; }
}
/* Icons only, and the reason the icons exist. The label is CLIPPED, not removed: it stays in
   the accessible name, so a screen reader still hears "Incidents" and voice control still
   matches on it — the glyph is what a sighted reader navigates by at this width, never what
   the destination is called. Deleting the text instead would leave four unnamed buttons.

   38rem is measured, not chosen: four labelled destinations, a labelled Sign out and the bar's
   own gutters ask for 583px, so anything under 608px went sideways — the labels stayed on
   past the width they fit at, and between 481 and 555px the rail alone was what made every
   page on the dashboard scroll horizontally. This number belongs to the label text above it;
   rename a destination and re-measure, because nothing here can work it out at runtime. */
@media (max-width: 38rem) {
  .rail .lbl {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  .rail nav a, form.signout button { gap: 0; padding: var(--sp-2); }
}
@media (prefers-reduced-motion: no-preference) {
  a, .pages a, .rail nav a, form.filters button, .signin-form button,
  form.signout button, .topo-tools button, .chart-dot, .chart-value, tbody tr {
    transition: color .12s ease, background-color .12s ease, border-color .12s ease,
                fill .12s ease, text-decoration-color .12s ease, transform .12s ease;
  }
}
`;
