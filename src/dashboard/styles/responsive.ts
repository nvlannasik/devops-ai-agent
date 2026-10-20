// Part of STYLES (../styles.ts): responsive and motion rules, and the rail as a drawer. A template literal — read the rules in styles.ts first.
export const RESPONSIVE_CSS = `
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
  /* And when the destinations outgrow one row they WRAP rather than spill: nine of them (the two
     memory pages, 2026-10-20) measured 329px past the bar at 900px and dragged the page sideways.
     A second row costs ~2.75rem of sticky bar; a clipped or icons-only label costs the word. */
  .rail nav { flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-4); flex: 1 1 auto; min-width: 0; }
  .rail-group { display: none; }
  .rail nav ul { flex-direction: row; flex-wrap: wrap; gap: var(--sp-1); margin: 0; }
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
  /* One column on a phone: a max-content label column plus a value is two columns of nothing
     much at 390px, and the sentence beside Confidence needs the whole width. */
  .rca-fields { grid-template-columns: minmax(0, 1fr); gap: var(--sp-1); }
  .rca-fields dt { margin-top: var(--sp-3); }
  .rca-fields > div:first-child dt { margin-top: 0; }
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
  form.signout button, .chart-dot, .chart-value, tbody tr {
    transition: color .12s ease, background-color .12s ease, border-color .12s ease,
                fill .12s ease, text-decoration-color .12s ease, transform .12s ease;
  }
  /* Slower than the rest, and it is the one duration on the page that is not .12s. A lift is a
     change of DEPTH rather than of state — at 120ms it snaps, which reads as the card jumping
     rather than rising — and box-shadow needs longer than a colour to be seen resolving at all. */
  .stat[data-linked] { transition: box-shadow .2s ease, transform .2s ease; }
}
`;
