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
`;
