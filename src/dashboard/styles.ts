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
main {
  width: 100%; min-width: 0; max-width: var(--maxw); margin: 0 auto;
  padding: var(--sp-10) var(--gutter) var(--sp-12);
}

/* auto on top, 0 on the bottom: horizontally centred like main, and pushed to the foot of a
   short page rather than left floating under a two-row table. */
footer.bottom {
  width: 100%; min-width: 0; max-width: var(--maxw); margin: auto auto 0;
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
  border-radius: var(--r-lg); padding: var(--sp-6);
  overflow: hidden;
}
.hero-body {
  display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: var(--sp-8); align-items: end;
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

/* One stat shelf, three homes: the overview's outcomes, its token totals, and the incident
   fact bar. They are the same kind of thing — a labelled value — so they are one component.
   auto-fit rather than a fixed count: four figures and five have to sit on the same grid.
   The dividers are a 1px grid gap with the border colour showing through from behind, not a
   border on each cell. A per-cell border cannot know it is at the start of a wrapped row —
   five stats in a four-wide grid left the fifth with a rule on the wrong side and none above
   it. The gap draws every divider the grid actually has, in both directions, and no others. */
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  gap: 1px; margin: 0; background: var(--border);
  border: 1px solid var(--border); border-radius: var(--r); overflow: hidden;
}
.stat { padding: var(--sp-4) var(--sp-5); background: var(--surface); min-width: 0; }
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
.prose-text + .prose-text, .prose-text + .rca-list, .prose-text + .rca-code { margin-top: var(--sp-4); }

/* ---------- RCA ---------- */
/* The RCA arrives as one string and comes apart into the sections its template declares, so
   these headings sit a level below the page's own. They deliberately do NOT repeat the h2
   treatment: a second rank of mono captions with hairlines would read as a second page rather
   than as the inside of one section. Sentence case, UI face, no rule — quieter by design. */
.rca-head {
  font-size: var(--fs-base); font-weight: 620; letter-spacing: -.01em;
  margin: var(--sp-6) 0 var(--sp-3);
}
.rca > .rca-head:first-child { margin-top: 0; }
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
.rca-fields dd { margin: 0; font-size: var(--fs-sm); min-width: 0; }
/* Bulleted sections the template does not name. They keep the reading face — an unrecognised
   section is still the agent's argument — but not the marker: the source already carries a •
   and re-adding a disc would double it. */
.rca-list {
  font-family: var(--font-prose); font-size: var(--fs-md); line-height: 1.7;
  max-width: 68ch; margin: 0; padding-left: var(--sp-5);
}
.rca-list li { margin-top: var(--sp-2); overflow-wrap: break-word; }
.rca-list li:first-child { margin-top: 0; }
/* Log excerpts and stack traces. The one place on this page where wrapping would destroy the
   thing being read, so it scrolls instead. */
.rca-code {
  font-family: var(--font-data); font-size: var(--fs-sm); line-height: 1.5;
  background: var(--surface-2); border-radius: var(--r-sm);
  padding: var(--sp-3) var(--sp-4); margin: 0; overflow-x: auto;
}
.rca-code code { font-size: inherit; }
/* Evidence and Ruled Out put a whole claim in the leading column. Cells wrap by default, but
   these ones need a ceiling too, or a long finding takes the table to the width of its
   longest sentence and the source column is squeezed to one word per line. */
.rca td.primary { max-width: 44ch; }

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
/* scroll-margin, not a scroll handler: below 60rem the rail is a sticky bar, and an anchor
   jump would otherwise park the row underneath it. Unconditional because the cost on a wide
   screen — where the rail is a column and overlaps nothing — is a row that lands a line lower
   than the top of the viewport, which is where you would want it anyway. */
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
  .rail nav a:hover { color: var(--text); background: var(--surface-2); }
  tbody tr:hover { background: var(--surface-2); }
  form.filters button:hover, .signin-form button:hover { filter: brightness(1.1); }
  form.signout button:hover { color: var(--text); background: var(--surface-2); }
  .pages a:hover { border-color: var(--accent); color: var(--accent); }
  .chart-bar:hover { fill: var(--text); }
  .chart-bar-current:hover { fill: none; stroke: var(--text); }
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
  .rail .brand { padding: 0; margin-right: auto; }
  .rail nav { flex-direction: row; gap: var(--sp-1); }
  .rail nav a[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--accent); }
  form.signout { margin-top: 0; margin-left: var(--sp-2); }
  form.signout button { width: auto; }
}
@media (max-width: 46rem) {
  :root { --gutter: max(var(--sp-4), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px)); }
  main { padding: var(--sp-6) var(--gutter) var(--sp-10); }
  footer.bottom { padding: 0 var(--gutter) var(--sp-8); }
  .hero { padding: var(--sp-5); }
  .hero-body { grid-template-columns: minmax(0, 1fr); gap: var(--sp-5); align-items: start; }
  .stat { padding: var(--sp-4); }
  .prose { padding: var(--sp-4); }
  .rca-fields > div { flex-direction: column; gap: var(--sp-1); }
  /* An SVG scales with its viewBox, so a 10px caption in a 720-unit chart renders near 4px on
     a phone. The per-bar counts go — every number is in the tables below, and each bar keeps
     its <title> — which frees the top gutter and lets the period labels grow back to legible. */
  .chart-value { display: none; }
  .chart-label { font-size: 19px; }
  /* Neither half of the hint is true here: there is no cursor to drag with and no ctrl key to
     hold. The gesture a phone does have — one finger across the map — needs no instructions. */
  .topo-hint { display: none; }
}
/* Icons only, and the reason the icons exist. The label is CLIPPED, not removed: it stays in
   the accessible name, so a screen reader still hears "Incidents" and voice control still
   matches on it — the glyph is what a sighted reader navigates by at this width, never what
   the destination is called. Deleting the text instead would leave four unnamed buttons. */
@media (max-width: 30rem) {
  .rail .lbl {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  .rail nav a, form.signout button { gap: 0; padding: var(--sp-2); }
}
@media (prefers-reduced-motion: no-preference) {
  a, .pages a, .rail nav a, form.filters button, .signin-form button,
  form.signout button, .topo-tools button, .chart-bar, tbody tr {
    transition: color .12s ease, background-color .12s ease, border-color .12s ease,
                fill .12s ease, text-decoration-color .12s ease;
  }
}
`;
