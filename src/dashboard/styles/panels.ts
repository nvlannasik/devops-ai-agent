// Part of STYLES (../styles.ts): type, panels and the delta marker. A template literal — read the rules in styles.ts first.
export const PANELS_CSS = `
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
  font-family: var(--font-display);
  font-size: var(--fs-xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.15;
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
/* .eyebrow is also worn by a <p> above a page title, where h2's section margin is wrong: the
   caption belongs to the title under it, not to the block above. */
.eyebrow { margin: 0 0 var(--sp-3); line-height: 1; text-wrap: wrap; }
/* The line above a page's title says WHERE the page is, and it is the one caption on the page
   that is not a section label — so it gives up the hairline every section label carries and
   takes the accent instead: a rule running out from "Monitor" to the far edge separated the
   word from the title it belongs to. Two selectors because there are two shapes of page head:
   the plain column (.doc) and the row with controls beside the title (.page-title). */
.doc > .eyebrow:first-child, .page-title > .eyebrow { color: var(--accent); }
.doc > .eyebrow:first-child::after, .page-title > .eyebrow::after { content: none; }
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

/* A card that names itself. The heading is INSIDE the frame rather than a caption floating
   above it: a section label over a card is two objects to read as one, and on a page that is
   mostly cards the labels became a second, fainter grid drawn between the real one.
   Sentence case in the display face, not the mono caption — the caption is still what a
   section of a document wears (the incident page), and a panel on a dashboard is not one. */
.card-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  min-width: 0;
}
h2.card-title {
  font-family: var(--font-display); font-size: var(--fs-md); font-weight: 600;
  text-transform: none; letter-spacing: -.01em; color: var(--text); margin: 0;
}
h2.card-title::after { content: none; }
.card-head > a { font-size: var(--fs-sm); white-space: nowrap; flex: 0 0 auto; }
/* A flush card has no padding of its own (the table inside runs edge to edge), so the heading
   brings its own — and the table gives up the frame it wears when it stands alone, or the card
   is a border drawn twice. */
.card.flush > .card-head { padding: var(--sp-4) var(--sp-5); }
.card.flush > .table-wrap {
  background: none; border: 0; border-top: 1px solid var(--border);
  border-radius: 0; box-shadow: none;
}
.card.flush > .empty { border-top: 1px solid var(--border); }

/* The window's count set over the series it summarises. The count is the caption of the chart,
   not a headline beside it: side by side, the count's column was sized against the digits and
   the chart got what was left, which on a tablet was not enough to read twelve periods in.
   Stacked, the chart has the full width of the page at every size and the two never compete. */
.chart-card {
  display: flex; flex-direction: column; gap: var(--sp-5);
  padding: clamp(var(--sp-5), 2.4cqi, var(--sp-6));
}
.chart-head {
  display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between;
  gap: var(--sp-2) var(--sp-5);
}
/* A figure and the words that say what it counts. One component for the chart's count and the
   token total: the number in the display face, the caption in the interface face under it. */
.figure { margin: 0; display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.figure b {
  font-family: var(--font-display); font-size: var(--fs-xl); font-weight: 600;
  letter-spacing: -.03em; line-height: 1.05; font-variant-numeric: tabular-nums;
}
.figure span { font-size: var(--fs-xs); color: var(--text-dim); }
/* Over the chart the pair lies on one baseline and the number goes up a size: it is the one
   figure on the page that owns a whole row. */
.chart-head .figure { flex-direction: row; align-items: baseline; gap: var(--sp-3); }
.chart-head .figure b { font-size: clamp(2rem, 1.5rem + 2cqi, 2.75rem); line-height: 1; }
.chart-head .figure span { font-size: var(--fs-sm); }
.chart-window {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim);
}

/* Three panels: how the incidents split, what the investigating cost, and which alerts keep
   coming back. NOT three abreast: abreast, a grid row is as tall as its tallest card, and the
   recurring list (up to ten rows) is two or three times the height of the other two — so
   Outcomes and Token usage stood mostly empty, at every desktop width (2026-11-11). The two
   short ones stack in the left column and the list takes the right column at THEIR combined
   height, scrolling inside it when it is longer. Below 38rem of page it is one column again,
   in markup order, and nothing scrolls inside anything. */
.panels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
.panels > :nth-child(1) { grid-column: 1; grid-row: 1; }
.panels > :nth-child(2) { grid-column: 1; grid-row: 2; }
.panels > :nth-child(3) { grid-column: 2; grid-row: 1 / span 2; }
.panels > .card { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
/* height 0 + flex-grow: the list adds nothing to the rows' height and then fills what the left
   column gave it — the card cannot stretch the row the way the list's own height would. */
.panels > :nth-child(3) .rank { flex: 1 1 0; height: 0; min-height: 10rem; max-height: none; }
/* With nothing recurred the list is an empty state; it sits in the middle of the tall card. */
.panels > :nth-child(3) > .empty { margin-block: auto; }
@container page (max-width: 38rem) {
  .panels { grid-template-columns: minmax(0, 1fr); }
  .panels > :nth-child(n) { grid-column: auto; grid-row: auto; }
  /* One column: nothing beside the list to match, and a scroller inside a scrolling phone page
     is a trap for a thumb. */
  .panels > :nth-child(3) .rank { flex: none; height: auto; min-height: 0; }
}
.panels .meta { margin: 0; }
/* The pair under the severity split is a second fact about the same incidents, so it sits under
   a rule rather than in a card of its own. */
.panels .stats.pair { padding-top: var(--sp-4); border-top: 1px solid var(--border); }

/* What recurred, most first. Rows rather than a table: three facts a row, and the count is the
   one a reader came for, so it stands alone at the end in the accent. */
/* Ten rows at most, and about four of them are what the panels beside this one are tall: past that the
   list scrolls inside its own frame rather than making the row three times the height of its
   shortest card. Every row holds a link, so the scrolled region is reachable from a keyboard. */
.rank {
  list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2);
  max-height: 17.5rem; overflow-y: auto;
}
.rank li {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  gap: var(--sp-3); padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm); background: var(--surface-2);
}
.rank a { font-weight: 600; color: var(--text); text-decoration: none; overflow-wrap: anywhere; }
.rank-sub { display: block; margin-top: 2px; font-size: var(--fs-xs); color: var(--text-dim); }
.rank-n {
  font-family: var(--font-display); font-size: var(--fs-md); font-weight: 600;
  color: var(--accent); font-variant-numeric: tabular-nums;
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
  .stats.facts .stat dd { margin-top: 0; font-size: var(--fs-base); font-weight: 600; text-align: right; }
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
   severity vocabulary to the spine, the badges and the share bar.
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
/* A figure, in the display face and at a display size: on a shelf of four the number is what
   the eye is meant to land on, and at the old 24px ceiling it was the same size as a heading
   two levels down. The sub-line under it goes back to the interface face — it is a sentence. */
.stat dd {
  margin: 0; margin-top: auto;
  font-family: var(--font-display); font-size: var(--fs-stat); font-weight: 600;
  letter-spacing: -.025em; font-variant-numeric: tabular-nums; line-height: 1.1;
  overflow-wrap: anywhere;
}
.stat dd span {
  display: block; font-family: var(--font-ui); font-size: var(--fs-xs); font-weight: 400;
  letter-spacing: 0; line-height: 1.4; color: var(--text-dim); margin-top: var(--sp-1);
}
/* The fact shelf is the exception, and it is an exception about CONTENT: its values are a
   namespace, a confidence and two timestamps. Identity, not figures — set as display type a
   timestamp becomes a headline and a namespace wraps mid-word. It keeps the interface face and
   the size the shelf had before the figures grew. */
.stats.facts .stat dd {
  font-family: var(--font-ui); font-size: var(--fs-fact); font-weight: 640;
  letter-spacing: -.02em; line-height: 1.2;
}
/* The lead tile: the one figure on a page that the page is ABOUT, filled with the accent so a
   shelf of four reads as one statement and three supporting ones instead of four of equal
   rank. One per shelf at most (statList's lead flag), and only the overview sets it — on Open,
   the count a reader came to see.
   Everything inside reads --on-accent. The caption and the sub-line are that colour mixed 85%
   toward itself over the fill, which measures 6.16:1 light and 5.72:1 dark; --text-dim on the
   fill would be 1.3:1. The glyph chip is a veil of the same ink rather than the brand tint,
   which on this ground is a pale box with nothing in it. */
.stat[data-lead] {
  background: var(--accent); border-color: transparent; color: var(--on-accent);
}
.stat[data-lead] dt, .stat[data-lead] dd span {
  color: color-mix(in srgb, var(--on-accent) 85%, var(--accent));
}
.stat[data-lead]:not([data-tone]) .kpi-icon {
  background: color-mix(in srgb, var(--on-accent) 18%, transparent); color: var(--on-accent);
}
/* A lead tile that also carries a tone — Open, when anything is — keeps the tone in its chip,
   which is a self-contained tint with its own ink and reads the same on any ground, and gives
   up the spine: a 3px red edge on an indigo fill is 1.3:1 against it, a mark nobody can see,
   and the same fact is already stated by the chip and by the delta beside it. */
.stat[data-lead][data-tone] { box-shadow: var(--shadow-sm); }
.stat[data-lead][data-tone] .kpi-icon { background: var(--tint); color: var(--ink); }

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

/* A shelf inside a panel. The panel is already the card, so the tiles drop the border, the
   shadow and the raised surface and become plain blocks — a card inside a card is a border
   drawn twice with 16px of nothing between the two. */
.stats.pair { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-5); }
.stats.pair .stat {
  padding: 0; background: none; border: 0; box-shadow: none;
}
.stats.pair .stat[data-tone] { box-shadow: none; padding-left: var(--sp-4); }
@container page (max-width: 34rem) { .stats.pair { grid-template-columns: minmax(0, 1fr); } }
`;
