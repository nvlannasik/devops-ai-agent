// One stylesheet, inlined into every page. No build step and no CDN — and the CSP this
// server sends (`default-src 'none'`) blocks font-src outright, so every typeface here is
// one the operating system already has. Components read only from the tokens at the top —
// never hard-code a colour below :root.
//
// THIS IS A TEMPLATE LITERAL, so three characters belong to JavaScript before they belong to
// CSS: a backtick, a dollar-brace, and a BACKSLASH. The last one is the quiet one — a CSS
// escape like \2193 for an arrow reads as a legacy octal escape and fails the whole build with
// "Legacy octal escape sequences cannot be used in template literals", nowhere near the line
// that caused it. Write the character itself (↓, ’, ·); the file is UTF-8 and so is the page.
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
  /* The floor was --sp-6, which is now exactly --stack — so a section boundary and an ordinary
     block boundary were the same distance and the heading was doing all the work of saying
     which was which. Raised a step so the three levels stay distinguishable at every width. */
  margin: clamp(var(--sp-8), 4cqi, var(--sp-10)) 0 var(--sp-4);
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
.sec { display: flex; align-items: center; gap: var(--sp-3); }
/* The section glyph in a tinted tile, matching the KPI chip. Same argument: the chip is
   brand-tinted and never severity-tinted, so it marks the KIND of section and leaves the
   severity palette alone. It is smaller than the KPI chip — a section label is a caption, and
   a chip the size of a KPI's would outweigh the words beside it. */
h2 .ico, .eyebrow .ico {
  box-sizing: content-box; width: 13px; height: 13px; padding: 4px;
  border-radius: 6px; background: var(--brand-tint); color: var(--accent);
  flex: 0 0 auto;
}
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
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--r); padding: var(--sp-5);
  box-shadow: var(--shadow-sm);
}
/* The topology canvas draws its own dot grid edge to edge, so it gets the frame without the
   inset — padding would leave a bare gutter around a background that is meant to be full-bleed. */
.card.flush { padding: 0; overflow: hidden; }

/* The overview's opening move is one composed object, not a rank of identical metric tiles:
   the 30-day count set against the weekly series it summarises. The count and its shape are
   one fact and belong in one frame — and nothing else does, which is why the supporting
   figures moved out to their own section rather than sitting on a shelf inside this one. */
.hero {
  position: relative;
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: clamp(var(--sp-5), 2.6cqi, var(--sp-6));
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  container: hero / inline-size;
}
/* The wash. A pseudo-element rather than a background on the panel itself, because the panel
   also has to hold a solid --surface-raised behind the chart's own translucent area fill —
   layering the gradient over the fill instead of under it would tint the data.
   It is a corner light, not a full-panel gradient: the strongest tint is at the top-left,
   behind the count, and it is gone by about 60% across, so the chart is drawn on flat ground.
   Very low alpha on purpose. This is the one piece of purely decorative colour on the page,
   and at anything stronger it becomes a background the severity badges have to be read on. */
.hero::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(120% 140% at 0% 0%,
      color-mix(in srgb, var(--brand-500) 16%, transparent) 0%,
      transparent 60%);
}
/* Everything inside sits above the wash. Without this the gradient paints over the count. */
.hero > * { position: relative; }
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
  /* justify-content has to be reset with the axis. It is 'center' on the column above, where
     it centres the pair VERTICALLY against a tall chart — flip the direction and the same
     declaration starts centring them horizontally, which floated the count into the middle of
     the panel as the only block on the page not aligned to the column's left edge. */
  .hero-figure {
    flex-direction: row; align-items: baseline; justify-content: flex-start; gap: var(--sp-3);
  }
}

/* One stat shelf, three homes: the overview's summary panel, its token totals, and the incident
   fact bar. They are the same kind of thing — a labelled value — so they are one component.

   The tiles are separate CARDS now, not cells sharing a frame. What they were is worth
   recording, because the old construction was correct for what it was: one bordered panel with
   a 1px grid gap and the border colour showing through from behind, which draws every divider
   the grid actually has and no others — a per-cell border cannot know it is at the start of a
   wrapped row, and five tiles in a four-wide grid left the fifth with a rule on the wrong side.
   Separate cards make that whole problem not exist: there are no dividers to get wrong, because
   a real gap separates them and each carries its own border and its own shadow.

   FOUR, then two, then one — an explicit ladder, not auto-fit. auto-fit divides by whatever
   fits and lands on three as often as not, which leaves a four-item row as 3 + 1: one tile
   alone on a second row, reading as a category of its own rather than the fourth of four. The
   ladder only ever halves, so every row stays full at every width. Every shelf on the page is
   built to exactly four items to keep that promise. Queried against page — the content column,
   not the window — because the rail's width is not the panel's to spend. */
.stats {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-4); margin: 0;
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
  /* And the shelf gives up the card treatment entirely, which is the other half of the same
     decision. Laying the caption and the value on one line exists to buy height back — four
     stacked tiles were a third of a phone screen above the analysis a reader came for — and
     giving every tile a border, a shadow and a 16px gap handed that height straight back and
     then some (measured 315px at 390px, against ~190px for this). One panel, hairline
     dividers: the construction the shelf had before the cards, kept for the one variant and
     the one width where it is worth more than the cards are. */
  .stats.facts {
    gap: 0; background: var(--surface-raised);
    border: 1px solid var(--border); border-radius: var(--r);
    box-shadow: var(--shadow-sm); overflow: hidden;
  }
  .stats.facts .stat {
    background: none; border: 0; border-radius: 0; box-shadow: none;
    padding: var(--sp-3) var(--sp-4);
  }
  .stats.facts .stat + .stat { border-top: 1px solid var(--border); }
  /* The spine survives the loss of the card — it is the row's severity, not the card's. */
  .stats.facts .stat[data-tone] { box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent); }
}
/* A column with the value pushed to the FLOOR of the tile by margin-top:auto. Grid stretches
   every tile in a band to the same height, so a value anchored to the bottom lands on the same
   line as its neighbours whether or not its caption wrapped — a row of figures that do not line
   up is a row that has to be read one tile at a time. Anchoring to the bottom rather than
   reserving a second caption line everywhere is the difference between alignment and a blank
   line in every tile on the page. It does mean the sub-line is part of what is anchored, so
   within one shelf the figures either all carry a sub or none do; statList's callers keep to
   that, and views.test.ts holds them to it. */
/* A column with the value pushed to the FLOOR of the tile by margin-top:auto — see the note
   above .stat dd. */
.stat {
  padding: clamp(var(--sp-4), 1.6cqi, var(--sp-5));
  background: var(--surface-raised); min-width: 0;
  border: 1px solid var(--border); border-radius: var(--r);
  box-shadow: var(--shadow-sm);
  display: flex; flex-direction: column; gap: var(--sp-3);
}
/* The same severity bar the tables use, on the one tile where a number means something is
   wrong. Only tiles that declare a tone get it — see the [data-tone] block under tables.
   The card's own shadow has to be restated here: box-shadow is one property, so a second
   declaration replaces the first rather than adding to it, and a toned tile would otherwise be
   the one card on the shelf sitting flat on the page. */
.stat[data-tone] {
  box-shadow: inset var(--spine-w) 0 0 var(--spine, transparent), var(--shadow-sm);
}
.stat dt {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim);
  line-height: 1.4;
}
/* The glyph in a tinted tile of its own rather than loose beside the caption. This is where
   most of the "modern dashboard" reading actually comes from — a KPI card is recognisable by
   the chip, the number and the delta, in that arrangement — and it costs nothing in meaning:
   the chip is brand-tinted, never severity-tinted, so it labels the CATEGORY and leaves the
   severity vocabulary to the spine, the badges and the donut.
   A toned tile is the exception: there the chip picks up the tone, because on that one card the
   category and the alarm are the same fact. */
/* The whole card is the target, not just the label. A stretched link: the anchor wraps only
   the label (so the accessible name is a phrase, not a card full of digits) and its ::after is
   an absolutely positioned box over the tile. That is what lets a <div class="stat"> inside a
   <dl> be clickable at all — <a> is not a permitted child of <dl>, so the link cannot wrap the
   tile from outside.
   Only [data-linked] tiles are positioned: an ::after with nothing to anchor to would escape
   to the nearest positioned ancestor, which is the page. */
.stat[data-linked] { position: relative; }
.stat-link { color: inherit; text-decoration: none; }
.stat-link::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
}
/* The ring goes round the CARD rather than round the two words inside it: the target is the
   card, so that is what a keyboard user has to see highlighted. :has is what makes it
   reachable; where it is unsupported the anchor keeps its own outline, which is smaller but
   never absent. */
.stat[data-linked]:has(.stat-link:focus-visible) {
  outline: 2px solid var(--accent); outline-offset: 2px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
}
.stat[data-linked]:has(.stat-link:focus-visible) .stat-link { outline: none; box-shadow: none; }
.stat .kpi-icon {
  display: grid; place-items: center; flex: 0 0 auto;
  width: 1.875rem; height: 1.875rem; border-radius: var(--r-sm);
  background: var(--brand-tint); color: var(--accent);
}
.stat[data-tone] .kpi-icon {
  background: var(--tint, var(--brand-tint)); color: var(--spine, var(--accent));
}
.stat .kpi-icon .ico { width: 15px; height: 15px; }
/* The caption line: chip, label, and the delta pushed to the far end. Centred rather than
   flex-start now — the chip is a 30px block and a 11px caption beside it reads as hung off its
   top edge otherwise. */
.stat dt { display: flex; align-items: center; gap: var(--sp-3); }
.stat dt .lbl { min-width: 0; }
.stat dd {
  margin: 0; margin-top: auto; font-size: var(--fs-stat); font-weight: 640;
  letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.2;
  overflow-wrap: anywhere;
}
.stat dd span {
  display: block; font-size: var(--fs-xs); font-weight: 400;
  letter-spacing: 0; color: var(--text-dim); margin-top: 3px;
}

/* ---------- delta ---------- */
/* What the same figure said over the previous window of equal length. A KPI without one states
   a number and leaves the reader to remember yesterday's.
   The direction is carried by a glyph AND by colour, never by colour alone — and the two are
   independent on purpose, because on this page they do not agree: incidents going UP is bad and
   MTTR going DOWN is good, so data-dir draws the arrow and data-tone decides whether that
   arrow is good news. A component that inferred one from the other would be wrong on half the
   shelf. Neutral (no tone) is the default: a delta with no established direction of "better"
   still deserves to be shown. */
.delta {
  display: inline-flex; align-items: center; gap: .2em; margin-left: auto; flex: 0 0 auto;
  padding: .2em .5em; border-radius: var(--r-pill);
  background: var(--surface-2); color: var(--text-dim);
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  letter-spacing: 0; font-variant-numeric: tabular-nums; white-space: nowrap;
  text-transform: none;
}
.delta[data-tone] { background: var(--tint); color: var(--ink); }
/* The arrow is content, not decoration — it is the half of the signal that survives greyscale
   and colour blindness — so it is generated here rather than written into the markup, where it
   would have to be escaped and kept in sync at four call sites. */
.delta[data-dir="up"]::before { content: "\\2191"; }
.delta[data-dir="down"]::before { content: "\\2193"; }
.delta[data-dir="flat"]::before { content: "\\2192"; }

/* Two panels side by side, halving to one. Not a shelf: these hold different KINDS of thing
   (a figure drawn as a ring, and a pair of counts), which is exactly what a shelf's equal
   tracks are wrong for — a ring wants its own square and a stat pair wants the rest.
   The floor is where the ring plus its legend stops fitting beside a two-tile shelf. */
.split {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  /* --stack, not the grid step. These two are not peer tiles the way four KPI cards are —
     they hold different KINDS of thing (a ring, a pair of counts) — and below 58rem they stop
     being a row at all and become two stacked blocks, which is precisely what --stack is the
     distance for. One value covers both arrangements. */
  gap: var(--stack);
  /* Stretch, which is the default and is stated here because it was wrongly overridden with
     'start'. With 'start' each panel took its own content height: the ring is about 90px
     taller than a two-tile shelf, so above 58rem the two cards ended on different lines and
     the row read as ragged. Two cards side by side are one row and end together — the panel
     is the unit, not its contents. Below 58rem there is one column and this does nothing. */
  align-items: stretch;
}
/* A stretched panel is taller than what is inside it, so the contents have to be told where to
   sit in the extra room, or the shorter card ends in a hundred pixels of nothing.
   The caption stays where a caption goes — at the top, labelling the panel. The FIGURE block
   below it takes the leftover space symmetrically, so the shorter card reads as a panel with
   generous padding rather than as one that ran out of content. Centred rather than spread to
   the bottom: two stat tiles with their labels at the top of a card and their numbers at the
   floor is a gap, not a layout, and only reads as deliberate on a single-figure card.
   One rule for both panels, because whichever of them is shorter is a function of the data. */
.split > .card { display: flex; flex-direction: column; }
.split > .card > .donut,
.split > .card > .stats { margin-top: auto; margin-bottom: auto; }
@container page (max-width: 58rem) { .split { grid-template-columns: minmax(0, 1fr); } }
/* A shelf inside a panel. The panel is already the card, so the tiles drop the border, the
   shadow and the raised surface and become plain blocks — a card inside a card is a border
   drawn twice with 16px of nothing between the two. */
.stats.pair { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-5); }
.stats.pair .stat {
  padding: 0; background: none; border: 0; box-shadow: none;
}
.stats.pair .stat[data-tone] { box-shadow: none; padding-left: var(--sp-4); }
@container page (max-width: 34rem) { .stats.pair { grid-template-columns: minmax(0, 1fr); } }
/* The panel's own caption. .eyebrow already carries the mono-caption-with-a-hairline treatment;
   inside a card the hairline has a border two rems away to run into, so it is dropped and only
   the caption is kept. */
.card > .eyebrow::after { content: none; }
.card > .eyebrow { margin-bottom: var(--sp-4); }

/* ---------- tables ---------- */
/* Same treatment as the log excerpt, for the tables that stay tabular on purpose (the MCP tool
   list): where the platform draws a bar, it is a hairline in this palette rather than the
   light default one across the foot of a dark panel. Where nothing overflows there is no bar
   and this costs nothing. */
.table-wrap {
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--r); overflow-x: auto;
  box-shadow: var(--shadow-sm);
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
}
table { width: 100%; border-collapse: collapse; }
/* The one table that is laid out FIXED rather than auto, and the exception is narrow on
   purpose. Every other table here wants the auto algorithm: it divides the frame in proportion
   to what each column could use, which is what balances the RCA's Evidence table at roughly
   65/35 without a number being written down anywhere.
   This one has a <details> inside its first cell. Auto layout sizes columns from their
   CONTENT, so opening a family inserted a list of tool names, raised that column's preferred
   width, and the whole table re-divided — the count column visibly jumped sideways under the
   reader's pointer, on the click that was supposed to reveal something.
   Fixed layout takes its widths from the header row and ignores what arrives later, so the
   count column stays where it was. The width is stated on the header cell because that is the
   row a fixed layout measures. */
table.caps { table-layout: fixed; }
/* Wide enough for the tracked-out "TOOLS" caption (~42px) plus the cell's own padding (32px),
   with room left for a four-digit count. */
table.caps th:last-child, table.caps td:last-child { width: 6rem; }
/* The header row sits on the recessed surface, the body on the raised one. That one step is
   what separates the two on a modern table — the old sheet leaned on the hairline alone, which
   is the same weight as every rule between rows and so said nothing about which row was the
   header. */
th {
  text-align: left; white-space: nowrap;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
  padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border);
  background: var(--surface-2);
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
/* Three properties per tone, and which one a rule reaches for is decided by what it paints:
     --spine  every MARK — a row's leading bar, a badge's dot, a donut arc, a legend swatch.
              Drawn from the --mark-* ramp, which is the saturated one (3:1, a graphic).
     --ink    every piece of TEXT in a tone — a badge's label, a delta's figure. Drawn from
              the --critical/--warning/... ramp, which is the readable one (4.5:1, on its tint).
     --tint   the wash the tone takes when it sits BEHIND that text.
   They are three values rather than one with alphas because the tint/ink pairs are the ones
   whose contrast was computed — see the ratio table at the top of this file — and a colour-mix
   would quietly leave that table describing something the page no longer renders. */
[data-tone="critical"] { --spine: var(--mark-critical); --tint: var(--tint-critical); --ink: var(--critical); }
[data-tone="warning"]  { --spine: var(--mark-warning);  --tint: var(--tint-warning);  --ink: var(--warning); }
[data-tone="info"]     { --spine: var(--mark-info);     --tint: var(--tint-info);     --ink: var(--info); }
[data-tone="ok"]       { --spine: var(--mark-ok);       --tint: var(--tint-ok);       --ink: var(--ok); }
td .sub { color: var(--text-dim); font-size: var(--fs-sm); margin-top: 2px; overflow-wrap: anywhere; }
/* The alert name is the row's only target, and at 15px/1.55 its line box is 23px — a whisker
   under the 24px a finger needs. Padding on an inline element grows the hit area without
   touching the line box, so the row stays exactly as tall as it looks. */
/* The one place the page-wide accent-on-links rule is opted out of, and the original reasoning
   is why: this column is fifty links, and fifty coloured links on a page whose job is to make
   one critical row unmissable are fifty pieces of competition for it. No underline at rest
   either — the row is a card-shaped target and the whole of it responds to a pointer, which is
   the affordance modern tables use. Both come back on hover (see the hover block). */
td.primary a {
  color: var(--text); font-weight: 600; padding-block: 3px; text-decoration: none;
}

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
/* A pill with a dot. The dot is the point: severity has to be legible without colour (WCAG
   1.4.1), and the word inside the badge already carries it — but the dot is what makes a column
   of badges scannable as SHAPES at a glance, before any of them is read. It reads the same tone
   variable the row's spine does, so a badge and its row can never disagree.
   ::before rather than a <span>: it is decoration around content that already says the thing,
   so it stays out of the accessible name and out of the markup. */
.badge {
  display: inline-flex; align-items: center; gap: .45em; white-space: nowrap;
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em;
  padding: .3em .6em; border-radius: var(--r-pill);
  background: var(--surface-2); color: var(--text-dim);
  border: 1px solid transparent;
}
.badge::before {
  content: ""; flex: 0 0 auto;
  width: .4em; height: .4em; border-radius: 50%;
  background: var(--spine, currentColor);
}
/* The tone pairs, drawn from the two-property vocabulary above rather than restated. The border
   is the tone at low alpha — on a dark scheme a tinted pill with no edge dissolves into the
   surface behind it at small sizes. */
.badge[data-tone] {
  background: var(--tint); color: var(--ink);
  border-color: color-mix(in srgb, var(--spine) 26%, transparent);
}
/* --- 2: the state column, which used to read backwards ---
   A firing incident wore the neutral badge — --text-dim on --surface-2 — while the resolved
   one wore green. So in a column whose whole job is "which of these is still live", the live
   rows were the quietest thing in it and the finished ones were the loudest.
   The fix spends no new colour, because colour is severity's and the row already states its
   severity one cell to the left. It spends WEIGHT instead: firing gets full --text, a visible
   edge and a mark-coloured dot; resolved keeps its green but stops being the emphasis. */
.badge[data-live] {
  background: var(--surface-raised); color: var(--text);
  border-color: var(--border-strong);
}
.badge[data-live]::before { background: var(--text-dim); }

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
  background: var(--surface-raised); border: 1px solid var(--border-strong);
  border-radius: var(--r-sm); padding: 0 var(--sp-3); min-width: 0; width: 100%;
  height: 2.75rem; line-height: normal;
}
form.filters input::placeholder { color: var(--text-dim); opacity: .8; }
form.filters .actions { display: flex; gap: var(--sp-4); align-items: center; height: 2.75rem; }
/* The one filled control on the page. A gradient rather than a flat fill, and a shadow tinted
   with the brand rather than with black — the two things that separate a 2024 primary button
   from a 2015 one. Both are the brand ramp doing what it was added for. */
form.filters button, .signin-form button {
  font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  color: var(--on-accent); border: 0; border-radius: var(--r-sm);
  background: linear-gradient(180deg, var(--brand-500), var(--brand-600));
  box-shadow: 0 1px 2px color-mix(in srgb, var(--brand-600) 40%, transparent);
  padding: 0 var(--sp-5); height: 2.75rem; white-space: nowrap;
}

/* ---------- sign-in ---------- */
/* One card, one field, and no chrome around it: the only decision on this page is whether you
   have the password. It is deliberately not dressed up as a product landing page — everyone
   who reaches it is an operator who came here to read an incident. */
.signin {
  max-width: 25rem; margin: var(--sp-10) auto;
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--r-lg); padding: var(--sp-8);
  box-shadow: var(--shadow-md);
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
  background: var(--surface-raised); border: 1px solid var(--border-strong);
  border-radius: var(--r-sm); padding: 0 var(--sp-3); height: 2.75rem; width: 100%;
}
/* Shares the filled treatment above; only the spacing differs, because this one is a block in
   a stacked form rather than an item on a control row. */
.signin-form button { width: 100%; margin-top: var(--sp-4); }
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
form.signout { display: flex; }
/* A step lighter than a destination. The rule it shares with .rail nav a gives it the same
   geometry — so the glyphs stay in one column and the foot lines up with the nav above it —
   and this is where it gives up the weight. Together with the rule above .rail-foot, that is
   what stops a reader scanning four destinations from finding five. */
form.signout button {
  font-family: inherit; line-height: inherit; cursor: pointer; text-align: left;
  width: 100%; background: none; border: 0; font-weight: 500;
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

/* ---------- filter chips ---------- */
/* For a filter with no field in the form. The form's six controls show their own state; this
   is for the one set by following a figure — the overview's "Made it worse" — which would
   otherwise shorten the list with nothing on screen saying why.
   One chip today. It is a list because the moment there are two, a row that wraps and keeps
   every label is the difference between a filter you can remove and one you cannot find. */
.chips {
  list-style: none; margin: 0 0 var(--sp-4); padding: 0;
  display: flex; flex-wrap: wrap; gap: var(--sp-2);
}
.chips li {
  display: inline-flex; align-items: center; gap: var(--sp-2);
  padding: .3em .3em .3em .7em; border-radius: var(--r-pill);
  background: var(--surface-2); border: 1px solid var(--border);
  font-size: var(--fs-sm); color: var(--text);
}
.chip-key {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .1em; color: var(--text-dim);
}
/* The remove control is a LINK, not a button: it goes to a URL with one parameter dropped,
   which is a navigation and needs no script. 1.5rem square so a finger has something to hit
   without the chip growing into a control-sized object. */
.chips a {
  display: grid; place-items: center; flex: 0 0 auto;
  width: 1.5rem; height: 1.5rem; border-radius: 50%;
  color: var(--text-dim); text-decoration: none; line-height: 1;
}

/* ---------- empty, pager ---------- */
/* A panel like every other panel, not a dashed outline. The dashed border was the page saying
   "something is missing here" — but on this dashboard an empty state is almost never a hole: a
   window with no incidents in it is the good outcome, and a fresh deployment with no data yet
   is the ordinary first hour. A real surface says "this is the answer"; a dashed one says "this
   failed to load".
   The glyph is what carries the reading now, and it is the section's OWN glyph passed in by the
   caller — an empty Remediation panel shows the wrench, so it is recognisably the same section
   whether or not it has rows. */
.empty {
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--r); box-shadow: var(--shadow-sm);
  padding: var(--sp-10) var(--sp-6);
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: var(--sp-2); color: var(--text-dim); font-size: var(--fs-sm);
}
.empty .kpi-icon {
  display: grid; place-items: center;
  width: 2.5rem; height: 2.5rem; border-radius: var(--r-sm);
  background: var(--surface-2); color: var(--text-dim);
  margin-bottom: var(--sp-2);
}
/* Dimmer than a KPI chip's glyph and on the neutral surface rather than the brand tint: this
   one marks an absence, and a brand-tinted chip would give it the same weight the page gives a
   figure someone is meant to read. */
.empty .kpi-icon .ico { width: 18px; height: 18px; }
.empty strong {
  display: block; color: var(--text); font-size: var(--fs-md);
  font-weight: 600; letter-spacing: -.01em;
}
/* The sentence under the headline, capped so it does not run the width of a 1400px panel. */
.empty span { display: block; max-width: 44ch; }
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
  box-shadow: none;
  font-family: var(--font-data); font-size: var(--fs-sm); font-variant-numeric: tabular-nums;
  color: var(--text-dim); text-decoration: none;
}
.pages a { color: var(--text); background: var(--surface-raised); border-color: var(--border); box-shadow: var(--shadow-sm); }
/* The second and last place colour marks something other than severity: which page you are
   on. It is the "current" case the accent is reserved for — the same signal the rail carries
   down its own leading edge — and it sits below the table, far from the rows whose spines it
   would otherwise be competing with. */
.pages .cur {
  background: linear-gradient(180deg, var(--brand-500), var(--brand-600));
  color: var(--on-accent); font-weight: 600;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--brand-600) 40%, transparent);
}
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
   the subject of the map earns weight, not hue. .topo-in / .topo-out / .topo-capability carry
   no colour by design — a tool family especially, since the agent knows the server ADVERTISED
   it, not that calling it works, and any colour there would be a health claim. */

/* React Flow measures its own canvas from this element and renders nothing if it collapses, so
   the height is stated rather than derived. clamp() rather than a fixed number for the same
   reason the rest of the dashboard uses one: the frame is 13.5rem narrower with a rail beside
   it, and a map that is a letterbox on a laptop is not worth the pixels it saves on a phone. */
.topo-view { height: clamp(26rem, 58vh, 42rem); width: 100%; }
/* Replaced by the mount as its first act; visible only if the bundle never ran. Centred rather
   than parked at the top-left, because at that point it is the entire contents of the frame. */
.topo-view[data-fallback] { display: grid; place-items: center; padding: var(--sp-6); }
.topo-fallback { margin: 0; color: var(--text-dim); font-size: var(--fs-sm); text-align: center; }

/* ---------- topology: the node ---------- */
/* One rule for all five kinds; the class the component adds decides the border and nothing
   else. Sizes come from NODE_SIZE in client/layout.ts and are applied by React Flow as inline
   width/height — do NOT restate them here, or dagre would be laying out one box and the
   browser painting another. */
.topo-node {
  box-sizing: border-box; width: 100%; height: 100%;
  display: flex; flex-direction: column; justify-content: center; gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface); border: 1.5px solid var(--mark-line); border-radius: 10px;
  overflow: hidden;
}
/* The subject of the map. Weight, not hue — see the note above. */
.topo-self { border-color: var(--text); border-width: 2px; }
/* The stroke of the CHIP is what marks a worker-reached backend, which is why the legend's
   swatch is a card and not a line. */
.topo-backend-worker { border-color: var(--accent); border-width: 2px; }
/* The only other state on this map. Dashed as well as amber: state never rests on colour
   alone anywhere on this dashboard. */
.topo-off { border-color: var(--warning); border-style: dashed; }
.topo-off .topo-node-title { color: var(--text-dim); }

/* An SVG had no ellipsis and clipped by character count. HTML does have one, so the label is
   truncated by the browser at whatever the card's real width turns out to be — and the
   untruncated value survives in the <a>'s aria-label and the card's title attribute. */
.topo-node-title,
.topo-node-sub { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topo-node-title { font-size: var(--fs-sm); font-weight: 550; color: var(--text); }
.topo-node-sub { font-family: var(--font-data); font-size: var(--fs-2xs); color: var(--text-dim); }
.topo-self .topo-node-title { font-weight: 650; letter-spacing: -.01em; }
/* heavy / light / unrouted. A backend the registry lists but no chain will ever pick is worth
   seeing, so "unrouted" is the one that gets the warning ink — the other two are neutral
   because which chain a backend is on is structure, not health. */
.topo-node-route {
  align-self: flex-start; margin-top: 2px;
  font-family: var(--font-data); font-size: var(--fs-3xs, .625rem); letter-spacing: .08em;
  text-transform: uppercase; color: var(--text-dim);
}
.topo-node-route[data-route="unrouted"] { color: var(--mark-warning, var(--warning)); }

/* Every card is a link to its own row in the tables below. No colour and no underline: the
   cards already read as objects, and decorating a hundred of them would undo the restraint the
   rest of the figure is built on. Focus needs no rule — the global :focus-visible outline sits
   OUTSIDE the card instead of overwriting the border, which is where the two state signals
   live. Hover moves the FILL, never the border, for that same reason: a hover that repainted
   the border would erase "not configured" for as long as the pointer sat there. */
.topo-node-link {
  display: flex; flex-direction: column; justify-content: center; gap: 2px;
  height: 100%; min-width: 0;
  color: inherit; text-decoration: none; cursor: pointer;
}
.react-flow__node:hover .topo-node { background: var(--surface-2); }

/* ---------- topology: a tool family, opened ---------- */
/* A family card carries two controls, because it has two things to offer: open its tools, or go
   to its row. They are siblings — a <button> inside an <a> is invalid, and either nesting makes
   one unreachable by keyboard. The button takes the card; the link is a corner affordance. */
.topo-capability .topo-node-toggle {
  display: flex; flex-direction: column; justify-content: center; gap: 2px;
  width: 100%; height: 100%; min-width: 0;
  padding: 0; background: none; border: 0; cursor: pointer; text-align: left;
  font: inherit; color: inherit;
}
/* + / − rather than a rotating chevron: the map draws no other glyph, and a character costs no
   markup, no icon font (blocked by default-src) and no rotation to keep in step with state. */
.topo-node-chevron {
  position: absolute; right: var(--sp-2); top: 50%; transform: translateY(-50%);
  font-family: var(--font-data); font-size: var(--fs-sm); line-height: 1; color: var(--text-dim);
}
.topo-capability:hover .topo-node-chevron { color: var(--text); }
/* Bottom-right, out of the chevron's way. It is the only place on this map where the "every
   card links to its row" contract needs its own affordance, because the card's own click was
   taken by the disclosure. */
.topo-node-rowlink {
  position: absolute; right: var(--sp-2); bottom: 2px;
  font-size: var(--fs-2xs); line-height: 1; color: var(--text-dim); text-decoration: none;
}
.topo-node-rowlink:hover { color: var(--accent); }

/* A tool is one identifier. No fill of its own, a lighter outline than a structural card, and
   mono type — it is a name the server reported, not a dependency this agent declared. */
.topo-tool {
  flex-direction: row; align-items: center; gap: var(--sp-2);
  padding: 0 var(--sp-2); border-style: dashed; border-width: 1px; border-radius: 6px;
}
.topo-tool .topo-node-title {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 500; color: var(--text-dim);
}
/* The word, never a colour — --accent is the SQS hop and --warning is not-configured, and a
   third meaning on either would make both ambiguous. Weight and case carry it instead, which is
   the same trick stateBadge() uses on the incident list. */
/* Sized to the type beside it and given no colour of its own: currentColor means it dims with
   the title on a not-configured card and brightens with it everywhere else, which is one fewer
   rule than stating both. flex-shrink 0 or a long title squeezes it to nothing. */
.topo-node-icon {
  width: 14px; height: 14px; flex: 0 0 auto; color: var(--text-dim);
  position: absolute; left: var(--sp-3); top: var(--sp-2);
}
.topo-self .topo-node-icon { color: var(--text); }
/* The icon sits in the card's own padding, so the text has to step aside for it rather than
   flow under it. Scoped to the cards that HAVE one — nothing else pays the indent. */
.topo-in .topo-node-title,
.topo-in .topo-node-sub,
.topo-out .topo-node-title,
.topo-out .topo-node-sub { padding-left: 1.25rem; }

/* One thing a dependency holds: a table, a key namespace. Two lines, and the second is a
   phrase rather than an identifier — which is why this is the widest leaf and the tool is the
   narrowest. Solid outline where a tool is dashed: a table is something this agent WRITES,
   a tool is something another process said it exposes. */
.topo-store {
  flex-direction: column; justify-content: center; gap: 1px;
  padding: 0 var(--sp-3); border-width: 1px; border-radius: 6px;
}
.topo-store .topo-node-title {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600; color: var(--text);
}
.topo-store .topo-node-sub { font-family: var(--font-ui); font-size: var(--fs-3xs, .625rem); }

.topo-node-write {
  margin-left: auto; flex: 0 0 auto;
  font-family: var(--font-data); font-size: var(--fs-3xs, .625rem); letter-spacing: .08em;
  text-transform: uppercase; font-weight: 700; color: var(--text);
}

/* ---------- topology: React Flow's own furniture ---------- */
/* The library ships a light-grey visual language of its own. These rules are the whole of the
   theming: everything else it draws is either invisible (handles) or already neutral. */
.react-flow__node { font-family: var(--font-ui); cursor: default; }
/* The map does not connect anything (nodesConnectable={false}), so a handle is a dot that
   promises an interaction which does not exist. */
.react-flow__handle { opacity: 0; pointer-events: none; }
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

/* ---------- topology: the key ---------- */
/* At the foot of the frame, under a hairline — it belongs to the drawing, so it sits inside
   the same card rather than under it as a caption for the whole section. */
.topo-legend {
  list-style: none; margin: 0; padding: var(--sp-3) var(--sp-4) var(--sp-4);
  border-top: 1px solid var(--border);
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-5);
  font-size: var(--fs-sm); color: var(--text-dim);
}
.topo-legend li { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
/* The swatch is a real fragment of the drawing — same element, same classes, same borders — so
   it overrides SIZE AND PADDING ONLY. Give it a colour of its own and the key stops being a
   key. The fixed size is why width/height are safe to state here and nowhere else on
   .topo-node: a swatch is never laid out by dagre. */
.topo-swatch { width: 22px; height: 14px; flex: 0 0 auto; padding: 0; border-radius: 3px; }
/* The affordance note is not a key, so it takes no swatch slot and sits at the far end. */
.topo-legend-note { margin-left: auto; font-style: italic; }
@container page (max-width: 46rem) {
  /* Nothing to push it to once the row wraps. */
  .topo-legend-note { margin-left: 0; }
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

/* The tool list a family expands into. Bare list, no bullets: these are identifiers, and a
   bullet column would only push them off the mono grid they line up on. */
details > summary { cursor: pointer; font-weight: 550; }
details > summary > span { margin-left: .35em; }
/* A <pre> inside a table cell's disclosure used to be a skill's playbook. It is not any more:
   the only <details> left in a table is the MCP tools list, whose content is a <ul>, and a
   skill's body moved to skillPage precisely because expanding a row pushed every skill below
   it off the screen. Removed rather than kept "in case" — dead CSS that names a construction
   the page has deliberately abandoned is a suggestion to bring it back.
*/
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
  a:hover { text-decoration-color: var(--accent); }
  h2 a:hover { text-decoration: underline; }
  a.standalone:hover { text-decoration: underline; }
  .rail nav a:hover { color: var(--text); background: var(--surface-2); }
  .rail nav a[aria-current="page"]:hover { color: var(--accent); background: var(--brand-tint); }
  .seg a:not([aria-current="true"]):hover { color: var(--text); }
  .topbar .brand:hover { color: var(--accent); }
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
  form.filters button:hover, .signin-form button:hover { filter: brightness(1.08); }
  form.signout button:hover { color: var(--text); background: var(--surface-2); }
  .pages a:hover { border-color: var(--accent); color: var(--accent); }
  .chips a:hover { background: var(--surface-raised); color: var(--text); }
  .donut-legend li > a:hover { background: var(--surface-2); }
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
@media (max-width: 60rem) and (min-width: 46.0625rem) {
  body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }
  body.bare { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  /* The rail is its own row here rather than a column beside the pane. Only the rail is told
     which row; the pane follows it by auto-placement, as it does at every other width. */
  .rail { grid-row: 2; }
  .rail {
    /* Stuck to the underside of the top bar, which is itself stuck at 0 — the same offset the
       side rail uses, for the same reason. */
    position: sticky; top: var(--topbar-h); z-index: 10; height: auto; align-self: stretch;
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
  /* The rail lies down, and the structure that made sense down a column has to be unmade.
     The group captions go: a caption belongs ABOVE the items it labels, and inline between
     them it reads as a sixth and seventh destination. The grouping survives where it still
     costs nothing — the two lists stay two lists, so a screen reader keeps the captions
     through aria-labelledby, and the eye gets a slightly wider gap between the pairs. */
  .rail nav { flex-direction: row; align-items: center; gap: var(--sp-4); flex: 1 1 auto; min-width: 0; }
  .rail-group { display: none; }
  .rail nav ul { flex-direction: row; gap: var(--sp-1); margin: 0; }
  /* The foot stops being a foot: no rule above it, no column, and the session note gives up
     its place — a bar this short is not where a sentence about the session belongs, and the
     footer at the bottom of every page already carries it in full. */
  .rail-foot {
    margin-top: 0; margin-left: auto; padding-top: 0;
    border-top: 0; flex-direction: row; align-items: center; flex: 0 0 auto;
  }
  .rail-note { display: none; }
  form.signout { margin-top: 0; flex: 0 0 auto; }
  form.signout button { width: auto; }
}
/* The note is the first thing to go: it is a courtesy (how fresh the page is, how long the
   session has), and the range control beside it is a control. Dropped at the width where the
   two together start squeezing the brand rather than at the width where the note itself stops
   fitting — a bar whose brand is ellipsised to keep a note is the wrong trade. */
@media (max-width: 52rem) { .topbar-note { display: none; } }
@media (max-width: 46rem) {
  :root { --gutter: max(var(--sp-4), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px)); }
  /* One step shorter, and the brand tile with it: 3.5rem of fixed chrome plus a nav bar under
     it is a lot of a phone screen spent before the first row of data. */
  :root { --topbar-h: 3rem; }
  .topbar .brand-mark { width: 1.5rem; height: 1.5rem; }
  main { padding: var(--sp-6) var(--gutter) var(--sp-10); }
  footer.bottom { padding: 0 var(--gutter) var(--sp-8); }
  .rca-sec + .rca-sec { margin-top: var(--sp-6); padding-top: var(--sp-5); }
  .rca-fields > div { flex-direction: column; gap: var(--sp-1); }
  /* Half the legend's affordance note is untrue here: there is no cursor to drag with and no
     ctrl key to hold. The gestures a phone does have — one finger to pan, two to zoom — need
     no instructions. The two clauses that survive are the ones a tap can reach, so the note is
     rewritten rather than hidden. */
  .topo-legend-note { font-size: 0; font-style: normal; }
  .topo-legend-note::after {
    content: "Tap + to open a card · ↓ jumps to its row below.";
    font-size: var(--fs-sm); font-style: italic;
  }
}
/* ---------- the rail, as a drawer ---------- */
/* NOTE: this is the SECOND @media block at 46rem — the other one, down in "responsive & motion",
   carries the gutter and the top bar's height. They are kept apart because this file is
   organised by component rather than by breakpoint, but the duplicate condition is a trip
   hazard: anything searching for "the 46rem block" will find whichever comes first. */
/* Below this width the rail stops being chrome that is always there and becomes something you
   open. It replaces an icons-only bar that used to live here: four glyphs with their labels
   clipped out, at a measured 38rem, with the label kept in the accessible name so the
   destinations were not left unnamed. That worked, and it was always a compromise — a rail
   with the words taken out is a rail you have to have learnt — and it does not survive the
   rail gaining group captions and a badge. A drawer keeps every label.

   Off-canvas rather than a pushed layout: the page underneath keeps its own width, so opening
   the menu re-flows nothing and closing it costs no second reflow.
   The page behind still scrolls while the drawer is open — stopping that needs a script, and
   the scrim is what makes it a non-issue in practice. */
@media (max-width: 46rem) {
  /* The rail is out of flow now, so the grid goes back to the two rows it has on a desktop. */
  body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .nav-toggle { display: grid; }

  .rail {
    position: fixed; z-index: 30;
    top: var(--topbar-h); bottom: 0; left: 0;
    width: min(17rem, 82vw); height: auto;
    padding: var(--sp-4) var(--sp-3);
    border-right: 1px solid var(--border);
    box-shadow: var(--shadow-md);
    /* Off to the left, and reachable by nothing while it is there: a drawer that is only
       translated out of sight is still in the tab order, so a keyboard lands in a menu it
       cannot see. visibility is what takes it out. */
    transform: translateX(-100%);
    visibility: hidden;
    overflow-y: auto;
  }
  #nav-open:checked ~ .rail { transform: none; visibility: visible; }

  /* The one piece of motion on this dashboard that carries meaning rather than polish: the
     drawer comes from the edge it lives on, which is what says it was always there rather than
     that it appeared. Slower than the .12s every other transition here takes — a panel
     crossing 270px in 120ms reads as a flicker.
     visibility transitions at zero duration and is DELAYED on the way out, so the panel leaves
     the tab order only after it has finished leaving the screen; without the delay it flips at
     frame zero and the slide is never seen. Nested inside the drawer's own block, so nothing
     above this width transitions a transform it never applies. */
  @media (prefers-reduced-motion: no-preference) {
    .rail { transition: transform .22s ease, visibility 0s linear .22s; }
    #nav-open:checked ~ .rail { transition: transform .22s ease, visibility 0s; }
    .nav-scrim { transition: opacity .22s ease; }
  }

  /* Tapping away from the drawer closes it — a second label for the same checkbox, covering
     everything under the bar. aria-hidden and pointer-only: it is an affordance for a pointer
     and duplicates the control that is already in the tab order. */
  .nav-scrim {
    position: fixed; inset: var(--topbar-h) 0 0; z-index: 25;
    display: block; opacity: 0; pointer-events: none;
    background: rgba(9, 12, 18, .5);
  }
  #nav-open:checked ~ .nav-scrim { opacity: 1; pointer-events: auto; }
}
@media (prefers-reduced-motion: no-preference) {
  a, .pages a, .rail nav a, .seg a, form.filters button, .signin-form button,
  form.signout button, .chart-dot, .chart-value, tbody tr, .topo-node {
    transition: color .12s ease, background-color .12s ease, border-color .12s ease,
                fill .12s ease, text-decoration-color .12s ease, transform .12s ease;
  }
  /* Slower than the rest, and it is the one duration on the page that is not .12s. A lift is a
     change of DEPTH rather than of state — at 120ms it snaps, which reads as the card jumping
     rather than rising — and box-shadow needs longer than a colour to be seen resolving at all. */
  .stat[data-linked] { transition: box-shadow .2s ease, transform .2s ease; }
}
`;
