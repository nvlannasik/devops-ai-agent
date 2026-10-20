// Part of STYLES (../styles.ts): tokens, the mobile drawer, the top bar and the rail. A template literal — read the rules in styles.ts first.
export const CHROME_CSS = `
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

  /* Radii up a step across the board, and a pill token for the things that are pills. This is
     the cheapest half of "modern": a 5px corner is a 2015 corner, and at 8/12/16 the same
     components read as surfaces rather than as boxes. --r-pill is deliberately absurd rather
     than half the height — a component whose height changes at a breakpoint would otherwise
     need the number recomputed, and 999px is always past it. */
  --r-sm: 8px; --r: 12px; --r-lg: 16px; --r-pill: 999px;
  /* The content column's ceiling. It is a measure for TABLES, not for prose — the RCA and every
     other run of sentences carries its own 68ch cap, so the page can be wider than a comfortable
     line length without any line getting longer. At 76rem a 1920 display spent a fifth of itself
     on empty gutters while a six-column table scrolled inside its own frame. */
  --maxw: 88rem;
  --rail-w: 13.5rem;
  --spine-w: 3px;
  /* The top bar's height, and the rail's sticky offset. One number, two elements: the bar is
     stuck at 0 and the rail is stuck under it, and CSS gives no way to read a sibling's height,
     so the agreement has to be written down. Anything that changes the bar's contents changes
     this. */
  --topbar-h: 3.5rem;
  /* The page's vertical rhythm, and the middle step of three. The scale is deliberate rather
     than assorted:
       16px  --sp-4   between PEER items in a grid — one KPI card and the next
       24px  --stack  between stacked BLOCKS of different kinds — the KPI shelf and the hero
       32px+ h2       between SECTIONS, which also carry a heading and a hairline
     Each step has to be clearly larger than the one inside it or the grouping stops reading:
     at 16px the hero looked like a fifth card, and at 24px for both blocks and sections a
     section boundary said nothing the heading did not already say. */
  --stack: var(--sp-6);
  /* The page gutter, and the notch allowance folded into it: below 60rem the rail becomes a
     sticky bar across the top, so on a phone held in landscape it would otherwise run under
     the camera cutout. env() needs its own fallback — without the 0px a browser that has
     never heard of safe areas throws the whole declaration away and the page loses its
     gutter entirely. */
  --gutter: max(var(--sp-6), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px));

  --bg: #f4f6f9; --surface: #fff; --surface-2: #eceff4;
  /* A third surface, above --surface. The KPI cards and the top bar sit on it, which is what
     lets a card read as lifted off the page without a shadow doing all the work — a shadow
     alone on a white card over a near-white page is a blur, not a level. */
  --surface-raised: #fff;
  --border: #dde2ea; --border-strong: #c2cad7;
  --text: #121821; --text-dim: #59636f;

  /* The brand, as a three-step ramp rather than a single value. 600 is the one that carries
     text and fills buttons (it is the only step that clears 4.5:1 on --surface); 500 and 400
     are for what is NOT text — gradient stops, an icon chip's tint, the ring on a focus glow —
     where the contrast bar is 3:1 for a graphic or nothing at all for decoration.
     --accent stays as the name every existing rule already reads, aliased to 600, so nothing
     downstream had to be rewritten to gain the ramp. */
  --brand-600: #0a6c73; --brand-500: #0f9aa4; --brand-400: #35bdc4;
  --accent: var(--brand-600); --on-accent: #fff;
  /* The tint the icon chips and the hero wash are built from. Written as a colour rather than
     an alpha over --surface because it has to sit on three different backgrounds (--surface,
     --surface-2, the hero's own gradient) and an alpha would pick up whichever is behind it. */
  --brand-tint: #e3f1f2;
  --glass: rgba(255, 255, 255, .78);

  /* Two levels, both tinted toward the page's own blue-grey rather than neutral black — a pure
     black shadow over a cool grey page reads as dirt. sm is the resting state of a card, md is
     what it lifts to on hover. */
  --shadow-sm: 0 1px 2px rgba(16, 24, 40, .05), 0 1px 3px rgba(16, 24, 40, .08);
  --shadow-md: 0 4px 14px rgba(16, 24, 40, .10), 0 2px 5px rgba(16, 24, 40, .05);

  --critical: #bf2f28; --warning: #8a5b00; --info: #1d5da6; --ok: #187446;
  --tint-critical: #f7e6e5; --tint-warning: #f1ebe0; --tint-info: #e4ecf4; --tint-ok: #e3eee9;
  /* The same four tones as MARKS rather than as text. The ramp above is picked to clear 4.5:1
     as type on its own tint; a mark — a row's spine, a badge's dot, a donut arc, a swatch —
     is a non-text graphic and needs 3:1, which buys back the saturation that bar was costing.
     It showed worst on warning: #8a5b00 is what an amber has to become to be readable as
     11px type on white, and as a 4.4-unit ring stroke it read as brown.
     Marks and type are never the same element, so the two never sit at different values in one
     place. Ratios against --surface-raised (light / dark), all >= 3:1:
       critical 4.57 / 5.42    warning 3.60 / 7.42    info 4.12 / 6.32    ok 3.47 / 7.39 */
  --mark-critical: #d93a30; --mark-warning: #c07600; --mark-info: #2f7ed8; --mark-ok: #1f9d5f;
  /* Structure, as opposed to state. The dependency map's edges and node outlines are graphics
     that are NEEDED to understand it — an arrow is nothing but its stroke, and in this scheme a
     node box is nothing but its outline, because --surface and --surface-raised are the same
     white so the box has no fill contrast at all. They were drawn in --border-strong, which is
     a BORDER token: 1.65:1, against the 3:1 a load-bearing graphic needs.
     The tell was that every mark on that map carrying STATE already cleared it comfortably
     (the agent 17.82, the worker edge 6.17, not-configured 5.87) — the palette discipline had
     been applied to state and skipped for structure.
     3.63:1 here, with headroom rather than sitting on the line. */
  --mark-line: #7d8797;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --surface: #151b23; --surface-2: #1d242e;
    /* Lighter than --surface here, not equal to it: on a dark page a raised element gains light
       rather than shadow, and a shadow under a dark card on a darker page is invisible. */
    --surface-raised: #1a212b;
    --border: #273040; --border-strong: #3b4655;
    --text: #e7ecf3; --text-dim: #94a1b1;

    /* The ramp inverts: on a dark surface the LIGHTEST step is the one that carries text, so
       600 is the brightest here and 400 the dimmest. Same names, same jobs, so every rule that
       reads --brand-600 for text and --brand-400 for decoration stays correct in both schemes
       without knowing which one it is in. */
    --brand-600: #3ec9be; --brand-500: #2ba79f; --brand-400: #1d7b76;
    --accent: var(--brand-600); --on-accent: #0d1117;
    --brand-tint: #16333a;

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, .30), 0 1px 3px rgba(0, 0, 0, .24);
    --shadow-md: 0 6px 18px rgba(0, 0, 0, .38), 0 2px 6px rgba(0, 0, 0, .26);

    --critical: #f4695f; --warning: #e0a53f; --info: #69a5ec; --ok: #4ec489;
    --tint-critical: #39272d; --tint-warning: #353127; --tint-info: #223143; --tint-ok: #1e3633;
    /* Identical to the text ramp here, and that is the finding rather than an oversight: on a
       dark surface the colour that reads as type (5.4-7.4:1) is already the colour that reads
       as its own name. It is only on white that a readable amber has to be darkened into a
       brown. The names still exist in both schemes so no rule has to know which one it is in. */
    --mark-critical: var(--critical); --mark-warning: var(--warning);
    --mark-info: var(--info); --mark-ok: var(--ok);
    /* 4.39:1 on --surface-raised, 4.69 on --surface — the map's two backgrounds. */
    --mark-line: #7b8695;
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
/* Two rows now, not one: the top bar spans both columns, and the rail and the pane sit under
   it. The rail is still a grid COLUMN rather than an overlay — content sits beside it and
   never under it, so there is no z-index race between them and no scroll handler deciding when
   the two overlap. The .skip child is out of flow and takes no cell. */
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-ui); font-size: var(--fs-base); line-height: 1.55;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  accent-color: var(--accent);
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--rail-w) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}
/* Sign-in and the "not configured" notice render no chrome at all — one column, one row, and
   the grid has to be told, or the page opens 13.5rem short of the left edge. */
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
/* Spans both grid columns, so the brand sits over the rail rather than inside it and the row
   of page-level controls has the full width to sit in. It is where anything that governs the
   WHOLE page lives — today the overview's time range — which is the one thing the rail could
   never hold: a rail is a list of destinations, and a control that changes what a destination
   shows is not one of them.

   Sticky with the rail sticking to its underside (see --topbar-h below). Two stuck elements,
   one above the other, is the arrangement that needs a number they agree on; there is no way
   to read a sibling's height in CSS, so the height is declared here and the rail offsets by
   the same token. Change one, change both — which is why it is a token and not a literal. */
.topbar {
  grid-column: 1 / -1; grid-row: 1;
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: var(--sp-4);
  height: var(--topbar-h); padding: 0 var(--gutter);
  background: var(--surface-raised); border-bottom: 1px solid var(--border);
}
/* The brand lock-up: a tinted tile with the product's own glyph, then the name. The tile is
   what carries the brand colour in the one place on the page where colour means nothing but
   identity — it labels no state, so it competes with no severity. */
.topbar .brand {
  display: flex; align-items: center; gap: var(--sp-3); min-width: 0;
  font-family: var(--font-data); font-size: var(--fs-sm); font-weight: 600;
  letter-spacing: -.02em; color: var(--text); text-decoration: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.topbar .brand-mark {
  display: grid; place-items: center; flex: 0 0 auto;
  width: 1.75rem; height: 1.75rem; border-radius: var(--r-sm);
  background: linear-gradient(140deg, var(--brand-500), var(--brand-600));
  color: var(--on-accent);
}
.topbar .brand-mark .ico { width: 16px; height: 16px; }
/* Everything after the brand is pushed to the far end as one group. */
.topbar-tools { display: flex; align-items: center; gap: var(--sp-3); margin-left: auto; min-width: 0; }

/* The segmented control: three ranges, one of them current. They are LINKS, not a form — each
   range is a URL, so it is bookmarkable, it survives a back button, and it needs no script and
   no submit. aria-current is what says which, exactly as the rail says which page.
   The track is inset and the current segment is a raised pill inside it, which is the shape
   that reads as "one of these" rather than as three buttons that happen to be adjacent. */
.seg {
  display: flex; align-items: center; gap: 2px;
  padding: 3px; border-radius: var(--r-pill);
  background: var(--surface-2); border: 1px solid var(--border);
}
/* Links only, now. This used to carry .seg label and .seg button as well: the topology
   page had a script-free scale control built from radio labels and a live toolbar built from
   buttons, and the point of the shared rule was that three different MECHANISMS could look
   like one component. React Flow's own <Controls> replaced both, so the time range is the last
   user and the other two selectors matched nothing. Removed rather than kept for symmetry —
   dead CSS naming a construction the page has abandoned is a suggestion to bring it back. Put
   them back the moment a second mechanism needs this look; that was a good rule. */
.seg a {
  display: flex; align-items: center; padding: 0 var(--sp-3); height: 1.75rem;
  border-radius: var(--r-pill); text-decoration: none;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: .06em; color: var(--text-dim); white-space: nowrap;
  background: none; border: 0; cursor: pointer; line-height: 1;
}
.seg a[aria-current="true"] {
  background: var(--surface-raised); color: var(--text);
  box-shadow: var(--shadow-sm);
}
/* A note in the bar rather than a control — how fresh the page is, and how long the session
   has left. Hidden before there is room for it: it is the least load-bearing thing here. */
.topbar-note {
  display: flex; align-items: center; gap: var(--sp-2);
  font-family: var(--font-data); font-size: var(--fs-2xs); color: var(--text-dim);
  white-space: nowrap;
}
/* A page that re-requests itself says so. The dot is the whole indicator — a pulsing one was
   tried and taken back out: it is the only thing on the page that would move, in the corner of
   an operator's eye, on a console meant to be left open, and the animation carried no
   information the word beside it does not. */
.topbar-note.live::before {
  content: ""; flex: 0 0 auto;
  width: .4rem; height: .4rem; border-radius: 50%; background: var(--ok);
}

/* ---------- chrome: rail ---------- */
/* A rail rather than a bar across the top. Three destinations are too few to earn a menu and
   too many to keep re-reading horizontally: down the side they become a fixed spatial index —
   the same three positions on every screen, all visible at once, none of them consuming the
   vertical space the tables want. */
.rail {
  grid-column: 1; grid-row: 2;
  position: sticky; top: var(--topbar-h); align-self: start;
  height: calc(100vh - var(--topbar-h));
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-3);
  background: var(--surface); border-right: 1px solid var(--border);
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
  padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm);
  font-size: var(--fs-sm); font-weight: 550; white-space: nowrap;
  color: var(--text-dim); text-decoration: none;
}
/* A filled pill in the brand tint, not a spine. The spine was the mark the TABLES use for a
   row's severity, borrowed here for "you are here" — and borrowing it was the compromise a
   page that spent no colour anywhere else had to make. The chrome carries the brand now, so
   the current destination can be marked the way a modern rail marks one: the whole item tinted
   and the glyph in full brand, which is legible at a glance from across the page instead of
   being a 3px edge that has to be looked for. */
.rail nav a[aria-current="page"] {
  color: var(--accent); background: var(--brand-tint); font-weight: 620;
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
  background: var(--tint-critical); color: var(--critical);
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  font-variant-numeric: tabular-nums; line-height: 1.6;
}
/* The current destination is already tinted in the brand, and a critical-tinted badge sitting
   inside it is two washes fighting over one row. On that one item the badge drops to the
   surface, keeping its ink. */
.rail nav a[aria-current="page"] .rail-count { background: var(--surface-raised); }

/* Everything that is not a destination, held at the floor of the column. The rule above it is
   the separation the sign-out button gave up when it stopped looking like a nav item. */
.rail-foot {
  margin-top: auto; padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: var(--sp-1);
}
/* The session note. It was in the top bar, where it was also the first thing dropped when the
   bar ran out of room — a poor place for the only statement that this dashboard cannot change
   anything. Here it sits under the destinations it qualifies. */
.rail-note {
  margin: 0; padding: 0 var(--sp-3) var(--sp-2);
  font-family: var(--font-data); font-size: var(--fs-2xs); color: var(--text-dim);
}

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
/* Vertical rhythm belongs to the PAGE, not to each block that happens to sit on it.
   Before this it belonged to the headings: a section heading carries its own top margin, so
   any two blocks a heading separated were spaced and any two it did not were touching. The
   KPI shelf and the hero sat edge to edge, and so did the token shelf and the backend table —
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
