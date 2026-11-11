// Part of STYLES (../styles.ts): tokens (light; dark is ./dark.ts), the mobile drawer, the top bar and the rail. A template literal — read the rules in styles.ts first.
export const CHROME_CSS = `
:root {
  color-scheme: light dark;

  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-data: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", Menlo, Consolas, monospace;
  /* The display face: the page title, the KPI figures, the chart count and the brand — the few
     places where type is a shape before it is a sentence. It is the one typeface this project
     SHIPS (Space Grotesk, OFL, served from /assets by stylesheet.ts). Everything written in
     sentences stays on the system stack, so a reader whose browser never fetches the file
     loses the character of four elements and none of the text. */
  --font-display: "Space Grotesk", var(--font-ui);

  --fs-2xs: .6875rem; --fs-xs: .75rem; --fs-sm: .8125rem; --fs-base: .9375rem;
  --fs-md: 1.0625rem; --fs-lg: 1.3125rem;
  --fs-xl: clamp(1.5rem, 1.15rem + 1.5vw, 2rem);
  /* A stat's value scales with the width of the COLUMN it sits in, not the viewport: the same
     four tiles are 300px wide on a desktop and 170px on a phone, and a figure sized for one is
     either lost or clipped in the other. cqi resolves against the nearest ancestor container
     (page, declared on main); with no container anywhere it falls back to the viewport, which
     is the old behaviour and still legible. */
  --fs-stat: clamp(1.375rem, 1rem + 1.5cqi, 2.25rem);
  /* The clamp the stat had before it became a display figure. The incident page's fact shelf
     holds identity — a namespace, a timestamp — and a sentence set at 36px is a headline. */
  --fs-fact: clamp(1.0625rem, .9rem + .55cqi, 1.5rem);

  --sp-1: .25rem; --sp-2: .5rem; --sp-3: .75rem; --sp-4: 1rem;
  --sp-5: 1.25rem; --sp-6: 1.5rem; --sp-8: 2rem; --sp-10: 2.5rem; --sp-12: 3rem;

  /* Radii up a step across the board, and a pill token for the things that are pills. This is
     the cheapest half of "modern": a 5px corner is a 2015 corner, and at 10/16/20 the same
     components read as surfaces rather than as boxes. --r-pill is deliberately absurd rather
     than half the height — a component whose height changes at a breakpoint would otherwise
     need the number recomputed, and 999px is always past it. */
  --r-sm: 10px; --r: 16px; --r-lg: 20px; --r-pill: 999px;
  /* The content column's ceiling. It is a measure for TABLES, not for prose — the RCA and every
     other run of sentences carries its own 68ch cap, so the page can be wider than a comfortable
     line length without any line getting longer. At 76rem a 1920 display spent a fifth of itself
     on empty gutters while a six-column table scrolled inside its own frame. */
  --maxw: 88rem;
  --rail-w: 14.5rem;
  --spine-w: 3px;
  /* The top bar's height, and the rail's sticky offset. One number, two elements: the bar is
     stuck at 0 and the rail is stuck under it, and CSS gives no way to read a sibling's height,
     so the agreement has to be written down. Anything that changes the bar's contents changes
     this. */
  --topbar-h: 3.5rem;
  /* The page's vertical rhythm, and the middle step of three. The scale is deliberate rather
     than assorted:
       16px  --sp-4   between PEER items in a grid — one KPI card and the next
       24px  --stack  between stacked BLOCKS of different kinds — the KPI shelf and the chart card
       32px+ h2       between SECTIONS, which also carry a heading and a hairline
     Each step has to be clearly larger than the one inside it or the grouping stops reading:
     at 16px the chart card looked like a fifth card, and at 24px for both blocks and sections a
     section boundary said nothing the heading did not already say. */
  --stack: var(--sp-6);
  /* The page gutter, and the notch allowance folded into it: below 60rem the rail becomes a
     sticky bar across the top, so on a phone held in landscape it would otherwise run under
     the camera cutout. env() needs its own fallback — without the 0px a browser that has
     never heard of safe areas throws the whole declaration away and the page loses its
     gutter entirely. */
  --gutter: max(var(--sp-6), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px));

  --bg: #f3f4f8; --surface: #fff; --surface-2: #f0f1f7;
  /* A third surface, above --surface. The KPI cards and the top bar sit on it, which is what
     lets a card read as lifted off the page without a shadow doing all the work — a shadow
     alone on a white card over a near-white page is a blur, not a level. */
  --surface-raised: #fff;
  --border: #e1e4ee; --border-strong: #c3c8d9;
  --text: #161a2b; --text-dim: #5b6178;

  /* The brand, as a three-step ramp rather than a single value. 600 is the one that carries
     text and fills buttons (it is the only step that clears 4.5:1 on --surface); 500 and 400
     are for what is NOT text — gradient stops, an icon chip's tint, the ring on a focus glow —
     where the contrast bar is 3:1 for a graphic or nothing at all for decoration.
     --accent stays as the name every existing rule already reads, aliased to 600, so nothing
     downstream had to be rewritten to gain the ramp. */
  --brand-600: #4338ca; --brand-500: #5b5fef; --brand-400: #818cf8;
  --accent: var(--brand-600); --on-accent: #fff;
  /* The tint the icon chips are built from. Written as a colour rather than
     an alpha over --surface because it has to sit on three different backgrounds (--surface,
     --surface-2) and an alpha would pick up whichever is behind it. */
  --brand-tint: #e9e8fb;

  /* The rail is ink in BOTH schemes — it does not turn white when the page does. That makes it
     a place with its own text ramp, and these are it. No rule inside the rail names them:
     .rail re-points the generic tokens (--text, --text-dim, --surface-2, --border, --accent,
     --on-accent) at this set, so every component that lands there — a nav item, the range
     control, the focus ring — reads the names it always read and comes out right.
     Ratios on --rail / on --rail-active, light scheme (dark is higher on every line):
       --rail-text 15.59 / 11.36    --rail-dim 7.99 / 5.82    --rail-accent 7.65 / 5.58 */
  --rail: #14172a; --rail-active: #2a2f52; --rail-line: #2a2f4a;
  --rail-text: #eef0fa; --rail-dim: #a8adc8; --rail-accent: #a5a0ff;

  /* Two levels, both tinted toward the page's own indigo-grey rather than neutral black — a pure
     black shadow over a cool grey page reads as dirt. sm is the resting state of a card, md is
     what it lifts to on hover. */
  --shadow-sm: 0 1px 2px rgba(22, 26, 43, .05), 0 1px 3px rgba(22, 26, 43, .08);
  --shadow-md: 0 4px 14px rgba(22, 26, 43, .10), 0 2px 5px rgba(22, 26, 43, .05);

  --critical: #b42318; --warning: #8a5300; --info: #1d5da6; --ok: #17713f;
  --tint-critical: #fdecea; --tint-warning: #fdf1dc; --tint-info: #e6eff9; --tint-ok: #e3f3ea;
  /* The same four tones as MARKS rather than as text. The ramp above is picked to clear 4.5:1
     as type on its own tint; a mark — a row's spine, a badge’s dot, a share-bar segment, a swatch —
     is a non-text graphic and needs 3:1, which buys back the saturation that bar was costing.
     It showed worst on warning: #8a5300 is what an amber has to become to be readable as
     11px type on white, and as a 4.4-unit ring stroke it read as brown.
     Marks and type are never the same element, so the two never sit at different values in one
     place. Ratios against --surface-raised (light / dark), all >= 3:1:
       critical 4.57 / 7.20    warning 3.60 / 9.18    info 4.12 / 7.91    ok 3.47 / 8.98 */
  --mark-critical: #d93a30; --mark-warning: #c07600; --mark-info: #2f7ed8; --mark-ok: #1f9d5f;
  /* Structure, as opposed to state. The dependency map's edges and node outlines are graphics
     that are NEEDED to understand it — an arrow is nothing but its stroke, and in this scheme a
     node box is nothing but its outline, because --surface and --surface-raised are the same
     white so the box has no fill contrast at all. They were drawn in --border-strong, which is
     a BORDER token: 1.65:1, against the 3:1 a load-bearing graphic needs.
     The tell was that every mark on that map carrying STATE already cleared it comfortably
     (the agent 17.26, the worker edge 7.90, not-configured 6.33) — the palette discipline had
     been applied to state and skipped for structure.
     3.63:1 here, with headroom rather than sitting on the line. */
  --mark-line: #7d8797;
}
/* The dark scheme's values are ./dark.ts, set down by styles.ts under two selectors: the
   system's preference, and the reader's own choice (data-theme on <html>, from a cookie —
   theme.ts). They are not here because one block cannot serve both. */

/* Every pair below is computed, not eyeballed — the two colour bugs this page has already
   shipped both came from guessing. Text/background ratios (light / dark):
     --text on --surface        17.26 / 14.81      --text-dim on --surface   6.13 / 7.31
     --accent on --surface       7.90 /  6.74      severity on --surface     6.05-6.63 / 7.70-9.82
     --text-dim on --bg          5.58 /  7.98      --on-accent on --accent   7.90 / 7.18
     --on-accent on --brand-500  4.85 /  5.15      (the LIGHT end of the button gradient — the
                                                    step that decides whether the label reads)
   Badge text on its own tint:   critical 5.75/7.05  warning 5.66/8.32
                                 info     5.71/6.99  ok      5.27/7.83
   All >= 4.5:1, the normal-text bar, in both colour schemes. */

* { box-sizing: border-box; }
/* scrollbar-gutter keeps the reserved track on pages short enough not to scroll (topology)
   so the header and content do not jump sideways when you navigate from a long one. */
html { -webkit-text-size-adjust: 100%; scrollbar-gutter: stable; }
/* The rail is a grid COLUMN, not an overlay: content sits BESIDE it and never under it, so
   there is no z-index race and no scroll handler deciding when the two overlap.
   One row above 60rem, and nothing across the top of it: the rail runs the full height of the
   window with the brand at its head, and a page's own controls sit in that page's heading
   (.page-head). There was a bar here until 2026-11-10 — brand at one end, the overview's range
   at the other — and it was 56px of sticky chrome holding two things that each had a better
   home. Below 60rem there is no column for a brand to head, so the bar comes back and the rows
   with it (responsive.ts). The single .skip child is out of flow and takes no cell. */
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-ui); font-size: var(--fs-base); line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  accent-color: var(--accent);
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--rail-w) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
/* Sign-in and the "not configured" notice render no chrome at all — one column, one row, and
   the grid has to be told, or the page opens 14.5rem short of the left edge. */
body.bare { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }

/* Links carry the brand. The rule this replaces held colour back from every link on the page
   so that a table of fifty of them could not compete with the one red row — and that
   reasoning still holds where it was aimed, which is why td.primary a below opts back out and
   stays --text until it is hovered. Everywhere else — a section's "All incidents", the way out
   of an empty state, a link inside a sentence — colour is what marks the link, and an
   underline in --border-strong was marking it about as well as nothing did. */
a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px;
    text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
    text-underline-offset: .18em; }
a.standalone { color: var(--accent); font-weight: 550; text-decoration: none; }
/* Every hover state in this stylesheet lives in one block near the bottom, behind
   @media (hover: hover). A tap on a touch screen latches :hover until the next tap
   somewhere else, so an un-gated hover leaves a row highlighted after you have already
   navigated away from it and come back. */
a, button, select, input, summary { touch-action: manipulation; }
/* WCAG 2.5.8: no target under 24px tall. The padding grows the hit box and the equal negative
   margin gives the height back, so no row moves — most of these are flex items, where padding
   alone would. A summary is a block and simply takes a floor. */
a.standalone:not(.page-actions a), .skill-card header a { padding-block: .25rem; margin-block: -.25rem; }
.eyebrow a { padding-block: .4rem; margin-block: -.4rem; }
details > summary { min-height: 1.5rem; }
/* The ring, plus a soft halo of the same colour. The ring is what meets the requirement — the
   halo is what makes it visible against a card that is itself bordered, where a 2px outline
   2px off the edge reads as a slightly thicker border. color-mix keeps one source of truth:
   change --accent and the glow follows without a second literal to remember. */
:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
}

.skip {
  position: absolute; left: var(--sp-3); top: var(--sp-3); z-index: 20;
  transform: translateY(-250%); background: var(--surface); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  padding: var(--sp-2) var(--sp-3); text-decoration: none; font-weight: 600;
}
.skip:focus-visible { transform: none; }

/* ---------- the mobile drawer ---------- */
/* Checkbox, label, scrim — the only disclosure a page with no script-src can toggle. It used
   to share this mechanism with the topology page's script-free zoom control; that control is
   gone (React Flow drives the map now), so this is the last of them and the pattern is worth
   restating here rather than pointing at a neighbour that no longer exists.
   The objection that killed a COLLAPSE toggle does not apply here, and the difference is worth
   writing down: a collapse toggle is a preference and has to survive navigation, which this
   cannot do — every page is a fresh server render. A drawer is transient, and closing when you
   pick a destination is exactly what it should do. The reset is the behaviour, not the bug.

   Focusable but not visible: the label is what a pointer hits, and the checkbox is what a
   keyboard tabs to and Space toggles. It carries the accessible name; the label carries none,
   or the control would be announced twice. What this pattern cannot give is aria-expanded — a
   checkbox announces as checked/unchecked instead, which is serviceable and is the price of
   the CSP. */
.nav-state {
  position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none;
  margin: 0; z-index: 40;
}
/* Both hidden by default: above the drawer's breakpoint the rail is simply present, and a
   control for a thing that is already open is a control with nothing to do. */
.nav-toggle, .nav-scrim { display: none; }
.nav-toggle {
  place-items: center; flex: 0 0 auto;
  width: 2.25rem; height: 2.25rem; margin-left: calc(var(--sp-2) * -1);
  border-radius: var(--r-sm); color: var(--text-dim); cursor: pointer;
}
.nav-toggle .ico { width: 20px; height: 20px; }
/* One glyph at a time. The closed state shows the bars, the open state the cross. */
.nav-toggle-close { display: none; }
#nav-open:checked ~ .topbar .nav-toggle .nav-toggle-open { display: none; }
#nav-open:checked ~ .topbar .nav-toggle .nav-toggle-close { display: block; }
#nav-open:checked ~ .topbar .nav-toggle { color: var(--text); }
/* The ring has to be painted on the label: the input it belongs to is a 1px box off in the
   corner, so its own focus ring would be invisible. */
.nav-state:focus-visible ~ .topbar .nav-toggle {
  outline: 2px solid var(--accent); outline-offset: 2px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
}

/* ---------- chrome: top bar ---------- */
/* Below 60rem only — display: none here, display: flex in responsive.ts. Above that width the
   rail is a column with the brand at its head and this bar would repeat it; below it the rail
   is a strip of links or a closed drawer, and something has to hold the brand and the burger.

   It is ink end to end, one ground with the rail lying under it or with the drawer that opens
   from it, so it carries the rail's INK SCOPE (see .rail below): the burger and the focus ring
   read the generic tokens and come out legible without a rule of their own.

   Sticky with the rail sticking to its underside. Two stuck elements, one above the other, is
   the arrangement that needs a number they agree on; there is no way to read a sibling's
   height in CSS, so the height is declared here and the rail offsets by the same token
   (--topbar-h). Change one, change both — which is why it is a token and not a literal. */
.topbar {
  --text: var(--rail-text); --text-dim: var(--rail-dim);
  --surface-2: var(--rail-active); --border: var(--rail-line);
  --accent: var(--rail-accent); --on-accent: var(--rail);
  display: none;
  grid-column: 1 / -1; grid-row: 1;
  position: sticky; top: 0; z-index: 20;
  align-items: center; gap: var(--sp-4);
  height: var(--topbar-h); padding: 0 var(--gutter);
  background: var(--rail); color: var(--text);
  border-bottom: 1px solid var(--border);
}
/* The brand lock-up: a tile with the product's own glyph, then the name in the display face.
   Rendered TWICE and shown once — at the head of the rail above 60rem, in the bar below it
   (layout.ts) — so it is styled by its own class rather than by where it sits. Both homes are
   ink, which is why it may read the rail's ramp by name. It shrinks before anything beside it
   does, and ends in an ellipsis when it has to. */
.brand {
  display: flex; align-items: center; gap: var(--sp-3); min-width: 0;
  flex: 0 1 auto;
  font-family: var(--font-display); font-size: var(--fs-base); font-weight: 600;
  letter-spacing: -.01em; color: var(--rail-text); text-decoration: none;
  white-space: nowrap;
}
/* The ellipsis belongs to the NAME, not to the lock-up: .brand is a flex container, and
   text-overflow acts on a block's own inline content — on the container it did nothing, and a
   name that ran out of room was cut mid-letter at 390px with no mark saying so. */
.brand > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* A flat tile in the rail's accent with the glyph in ink (7.65:1), not a gradient: the two
   brand steps a gradient would run between do not both clear 3:1 against one glyph colour in
   both schemes, and a mark that is legible at one end of itself is not a mark. */
.brand-mark {
  display: grid; place-items: center; flex: 0 0 auto;
  width: 1.75rem; height: 1.75rem; border-radius: var(--r-sm);
  background: var(--rail-accent); color: var(--rail);
}
.brand-mark .ico { width: 16px; height: 16px; }
/* At the head of the column: inset to the nav items' own text edge, so the tile sits over the
   glyphs below it, and held clear of the first group caption. It does not shrink here — the
   rail scrolls when the window is short, and the brand is not what gives way. */
.rail .brand { flex: 0 0 auto; padding: var(--sp-1) var(--sp-3); margin-bottom: var(--sp-5); }

/* ---------- a page's own controls ---------- */
/* What sits at the far end of a page's heading (pageHead in parts.ts; the row itself is
   .page-head in content.ts). A control that changes what ONE page shows belongs beside that
   page's title — the rail is a list of destinations and cannot hold it, and a bar across every
   page held it for the one page that had any. */
.page-title { flex: 1 1 20rem; min-width: 0; }
.page-title > .meta { margin: 0; }
.page-tools {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4);
  flex: 0 0 auto; max-width: 100%;
}

/* The segmented control: a few views of one page, one of them current. They are LINKS, not a
   form — each is a URL, so it is bookmarkable, it survives a back button, and it needs no
   script and no submit. aria-current is what says which, exactly as the rail says which page.
   A raised white track on the page's ground with the current segment filled inside it: the
   shape that reads as "one of these" rather than as three buttons that happen to be adjacent,
   and the same radius the cards under it are cut from. */
.seg {
  display: flex; align-items: center; gap: 2px;
  padding: 3px; border-radius: var(--r-sm);
  background: var(--surface-raised); border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}
/* Links only, now. This used to carry .seg label and .seg button as well: the topology
   page had a script-free scale control built from radio labels and a live toolbar built from
   buttons, and the point of the shared rule was that three different MECHANISMS could look
   like one component. React Flow's own <Controls> replaced both, so links are the last
   mechanism and the other two selectors matched nothing. Removed rather than kept for
   symmetry — dead CSS naming a construction the page has abandoned is a suggestion to bring it
   back. Put them back the moment a second mechanism needs this look; that was a good rule. */
.seg a {
  display: flex; align-items: center; padding: 0 var(--sp-4); height: 2rem;
  border-radius: calc(var(--r-sm) - 3px); text-decoration: none;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: .06em; color: var(--text-dim); white-space: nowrap;
  background: none; border: 0; cursor: pointer; line-height: 1;
}
.seg a[aria-current="true"] { background: var(--accent); color: var(--on-accent); }
/* A note beside the control rather than a control — how fresh the page is. */
.page-note {
  display: flex; align-items: center; gap: var(--sp-2);
  font-family: var(--font-data); font-size: var(--fs-2xs); color: var(--text-dim);
  white-space: nowrap;
}
/* A page that re-requests itself says so. The dot is the whole indicator — a pulsing one was
   tried and taken back out: it is the only thing on the page that would move, in the corner of
   an operator's eye, on a console meant to be left open, and the animation carried no
   information the word beside it does not. --mark-ok rather than --ok: this is a mark, 6px
   across, and the text green is tuned for letters on a tint. */
.page-note.live::before {
  content: ""; flex: 0 0 auto;
  width: .4rem; height: .4rem; border-radius: 50%; background: var(--mark-ok);
}

/* ---------- chrome: rail ---------- */
/* A rail rather than a bar across the top. Three destinations are too few to earn a menu and
   too many to keep re-reading horizontally: down the side they become a fixed spatial index —
   the same three positions on every screen, all visible at once, none of them consuming the
   vertical space the tables want. */
/* THE INK SCOPE. The first six declarations re-point the generic tokens at the rail's own ramp
   for everything inside it. That is the whole mechanism by which a nav item, a caption, the
   theme control, sign out and the focus ring are legible on ink without one of them knowing
   where it is — and why nothing below this line, in this file or any other, hard-codes a
   colour for the rail. A component moved INTO the rail needs no change; one that reads a token
   not listed here (--surface, --brand-tint) would paint a light patch on ink, so add the token
   to the scope rather than a colour to the component.
   overflow-y, because the column is exactly one viewport tall and nine destinations plus the
   foot are about 36rem: on a short window the foot would otherwise be pushed out of reach. */
.rail {
  --text: var(--rail-text); --text-dim: var(--rail-dim);
  --surface-2: var(--rail-active); --border: var(--rail-line);
  --accent: var(--rail-accent); --on-accent: var(--rail);
  grid-column: 1; grid-row: 1;
  position: sticky; top: 0; align-self: start;
  height: 100vh;
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-3) var(--sp-4);
  background: var(--rail); color: var(--text); border-right: 1px solid var(--border);
  overflow-y: auto; scrollbar-width: thin;
}
.rail nav { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.rail nav ul {
  list-style: none; margin: 0 0 var(--sp-4); padding: 0;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.rail nav ul:last-child { margin-bottom: 0; }
/* The group caption. Same mono-uppercase treatment every other caption on the page takes, one
   step dimmer than the items it labels — it is a divider that happens to have a word in it,
   not a fifth thing to read. */
/* No opacity. A .75 alpha over the surface was tried and measured: it renders --text-dim as
   #828a93 on white, which is 3.50:1 — under the 4.5:1 this 11px text needs. What separates a
   caption from the items under it here is its SIZE, its tracking and its case, none of which
   cost contrast. The same applies to .rail-note below (at .8 it measured 3.89:1). */
.rail-group {
  margin: var(--sp-3) 0 var(--sp-2);
  padding: 0 var(--sp-3);
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim);
}
.rail-group:first-child { margin-top: 0; }
/* Sign out is no longer shaped like a destination. It was — deliberately, back when the rail
   held nothing else — and the cost was that a reader scanning four items found five, with the
   fifth one being a way OUT rather than a place to go. It keeps the item's geometry so the
   column stays aligned, and gives up the item's weight; the rule above the foot is what
   separates leaving from arriving. */
.rail nav a, form.signout button {
  display: flex; align-items: center; gap: var(--sp-3);
  min-height: 2.5rem; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
  font-size: var(--fs-sm); font-weight: 550; white-space: nowrap;
  color: var(--text-dim); text-decoration: none;
}
/* A filled pill, not a spine. The spine was the mark the TABLES use for a row's severity,
   borrowed here for "you are here" — and borrowing it was the compromise a page that spent no
   colour anywhere else had to make. On ink the current destination is marked three ways at
   once: the item lifts one step (--surface-2 is the rail's active ground here), its label goes
   from the dim ramp to full, and its glyph alone takes the accent. The label stays off the
   accent on purpose — a violet word in a column of grey ones reads as a link, and what this
   has to say is "here", which is the fill's job. */
.rail nav a[aria-current="page"] {
  color: var(--text); background: var(--surface-2); font-weight: 620;
}
.rail nav a[aria-current="page"] .ico { color: var(--accent); }
/* How many are firing, on the destination that lists them. Pushed to the far end by the auto
   margin so every badge in the column shares one right edge — a count that stepped left and
   right with the length of its label would stop being a column to scan.
   tabular-nums for the same reason: 1 and 7 have to be the same width or the badge twitches
   between renders as the count changes. */
.rail-count {
  margin-left: auto; flex: 0 0 auto;
  min-width: 1.5rem; padding: 0 .4em; text-align: center;
  border-radius: var(--r-pill);
  background: var(--accent); color: var(--on-accent);
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 700;
  font-variant-numeric: tabular-nums; line-height: 1.6;
}
/* The badge is the rail's accent with ink figures (7.65:1), not the critical tint it used to
   be: that tint is a pale wash made for a white page and reads as a hole in an ink column,
   and the one saturated mark the rail has is enough to make a count findable. What the count
   MEANS is said by the row it sits on and by the word in its accessible name. It needs no
   variant for the current item — the fill clears 5.58:1 against the active ground too. */

/* Everything that is not a destination, held at the floor of the column: the colour theme,
   then one line that says what this session is and how to end it. The rule above it is the
   separation the sign-out button gave up when it stopped looking like a nav item. */
.rail-foot {
  margin-top: auto; padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: var(--sp-2);
}
/* The note and the way out share a line — the note at the nav items' text edge, sign out at
   the far end. They wrap rather than squeeze: a longer session length or a larger text size
   puts sign out on a line of its own, still against the right edge. */
.rail-session {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 0 var(--sp-2); min-width: 0;
}
/* The session note: the only statement on the page that this dashboard cannot change
   anything, so it sits under the destinations it qualifies rather than in a bar that dropped
   it first whenever room ran out. */
.rail-note {
  margin: 0; padding: 0 0 0 var(--sp-3);
  font-size: var(--fs-2xs); color: var(--text-dim); white-space: nowrap;
}
/* The colour theme: three LINKS, for the reason .seg is links — each is a URL (/theme/dark),
   the server answers it with a cookie and a redirect back, and the next render carries
   data-theme on <html>. No script, so no flash of the wrong scheme either: the page arrives
   already in the one that was asked for. aria-current says which, as the range control does.
   A track one step up from the rail with the current segment cut back DOWN to the rail's own
   ground — inset rather than filled, so the accent in this column still belongs to "you are
   here" and the badge, and a preference does not compete with either. */
.theme {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px;
  margin: 0; padding: 3px; border-radius: var(--r-sm);
  background: var(--surface-2);
}
.theme a {
  display: grid; place-items: center; height: 1.75rem; padding: 0 var(--sp-2);
  border-radius: calc(var(--r-sm) - 3px); text-decoration: none;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: .06em; color: var(--text-dim); white-space: nowrap; line-height: 1;
}
.theme a[aria-current="true"] { background: var(--rail); color: var(--text); }

/* A visually hidden label, for text that a screen reader needs and the eye does not — the
   badge's "open", which would otherwise be announced as a bare number beside a destination. */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
/* flex-shrink 0: a long label must squeeze the text, never the glyph — a 4px-wide triangle
   is not an icon, it is a rendering fault. */
.ico { width: 18px; height: 18px; flex: 0 0 auto; }

/* min-width 0 on a grid column that holds tables: without it the column's automatic minimum
   size is its widest cell, and one long alert name widens the whole page instead of scrolling
   inside its own .table-wrap. */
/* Deliberately NOT given a grid-row. Auto-placement puts it in the first free cell, which is
   exactly right in all three layouts this sheet has — beside the rail at desktop, under it when
   the rail lies down, and in the only cell there is on a bare page. Naming a row instead is what
   broke sign-in: grid-row:2 on a one-row body.bare grid creates an implicit second row and
   drops the card to the bottom of the viewport. */
.pane { min-width: 0; display: flex; flex-direction: column; }
/* The 100% width is doing real work here, not restating a default. An auto cross-axis margin
   is what centres main in the pane, and a flex item with one does not stretch — it takes its
   fit-content width instead, which on a phone is the width of the widest table, so main grew
   past the viewport and dragged the whole page into a horizontal scroll while .table-wrap sat
   there scrolling nothing. A definite width plus min-width 0 pins main to the pane and hands
   the overflow back to the wrap, where it belongs. */
/* container is what lets everything below size itself against the CONTENT column instead of
   the window. The two are not the same measurement and never were: the rail is a 14.5rem column
   above 60rem and a bar across the top below it, so a 1000px window hands main either 784px or
   1000px. A media query cannot tell those apart — it only ever sees 1000px — which is how a
   panel ends up tuned for a width it never actually gets. Named, so a container added inside a
   component later cannot silently capture a query written for this one. */
main {
  width: 100%; min-width: 0; max-width: var(--maxw); margin: 0 auto;
  padding: clamp(var(--sp-6), 3cqi, var(--sp-8)) var(--gutter) var(--sp-12);
  container: page / inline-size;
}
/* Vertical rhythm belongs to the PAGE, not to each block that happens to sit on it.
   Before this it belonged to the headings: a section heading carries its own top margin, so
   any two blocks a heading separated were spaced and any two it did not were touching. The
   KPI shelf and the chart card sat edge to edge, and so did the token shelf and the backend table —
   both pairs are one section with two blocks in it, which is the exact case nothing covered.
   A minimum, not an addition: adjacent siblings' margins COLLAPSE, so this only ever raises a
   gap that is smaller than --stack and never adds to a heading's own larger one. That is what
   lets one rule state the floor without re-tuning every component above it.
   Scoped to main's direct children. A document page's body is one .doc element, so the
   lockups inside it — an eyebrow against its own title — keep the tighter spacing they are
   supposed to have. */
main > * + * { margin-top: var(--stack); }
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
`;
