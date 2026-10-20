// Part of STYLES (../styles.ts): the benchmark page. A template literal — read the rules in styles.ts first.
export const BENCH_CSS = `
/* ---- Benchmark ---- */
/* The run cards are siblings in .doc, and nothing was spacing them: main > * + * reaches .doc
   itself, not what is inside it, so consecutive cards sat at a gap of exactly 0 and their two
   1px borders met as one line. Three runs read as one box with rules through it.
   --stack, not --sp-4, because that is what these same cards would get from main > * + * if
   they were not wrapped — the wrapper is a layout detail and should not change the rhythm. */
.bench-run + .bench-run { margin-top: var(--stack); }
/* pass^k is set large and everything else is meta, because the page has one headline number
   and three that only make sense next to it. */
.bench-run { display: grid; gap: var(--sp-3); }
.bench-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2) var(--sp-4); }
/* The headline and the k it is over are one phrase, and at --fs-xl beside --fs-sm a single
   collapsed space between them is not a gap: "16%" and "pass^5" read as one token. */
.bench-head > :first-child { display: flex; align-items: baseline; gap: var(--sp-2); }
.bench-rate { font-size: var(--fs-xl); font-weight: 650; line-height: 1; letter-spacing: -.02em; }
.bench-sub { flex: 1 1 auto; }
.bench-meta { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); align-items: center; }
.bench-axes { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
/* ONE grid for the whole list, with the rows contributing their cells to it — not a grid per
   row. Both spellings align five attempts under five attempts, which is the point of the
   column; the difference is what the name column is WIDE. A per-row grid cannot size a track
   from a sibling row, so it needed a number picked up front, and 20rem was nearly twice the
   longest case id: every row had a 145px canyon between the name and the marks it labels.
   max-content is that measurement taken rather than guessed. The minmax(0, ...) is not
   decoration: a bare max-content track cannot shrink, so at 390px a long case id pushed the
   card 48px past the viewport and put the whole page into a sideways scroll. With the floor at
   0 the track is the longest name where there is room and wraps where there is not.
   Changing a list item's display destroys its implicit role — the same trap the tables carry,
   documented on table() — so both roles are declared in the markup. */
/* The border is the card's one internal seam: above it the run identifies and scores itself,
   below it is the per-case detail. Five bands at one gap read as a single list. */
.bench-cases { list-style: none; margin: var(--sp-1) 0 0; padding: var(--sp-4) 0 0;
               display: grid; grid-template-columns: minmax(0, max-content) auto;
               gap: var(--sp-1) var(--sp-5); align-items: baseline;
               border-top: 1px solid var(--border); }
/* > li, not li: the case-why list nested inside these rows is made of list items too, and a
   descendant selector handed THEM display: contents as well — which took every reason out of
   its own box and ran "#2 ...no proposal#3 proposed..." together as one line of text. */
.bench-cases > li { display: contents; }
/* Monospace so five attempts line up under five attempts across rows — the shape is the point:
   "xxxx." is a flaky case that finally landed, "...x." is a good one that slipped. */
.marks { font-family: var(--font-data); font-size: var(--fs-base); letter-spacing: .22em; }
.mk-pass { color: var(--ok); }
.mk-fail { color: var(--critical); }
/* Why a case failed, under the case. Spans both columns rather than sitting in the marks
   column: a reason is a sentence and that column is sized to five characters.
   overflow-wrap: anywhere, not break-word — a reason can carry a truncated JSON payload with
   no spaces in it, and only anywhere lowers min-content width enough to stop it widening the
   whole grid. The 68ch is the same measure the prose blocks use. */
/* Asymmetric on purpose: the disclosure belongs to the case ABOVE it, and at an even margin it
   sat equidistant between that case and the next one — reading as attached to both. Proximity
   is the only thing saying which case it explains. */
/* width 0 with min-width 100%, and it is not a trick for its own sake: a grid item that SPANS
   intrinsic tracks contributes its own max-content to sizing them, so once the reasons stopped
   wrapping at 68ch the longest one dragged the case-name track from 302px to 684 and pushed
   every marks strip to the middle of the card. Zero width contributes nothing to that
   calculation; min-width then lays it back out across the full span it was given. */
.case-why { grid-column: 1 / -1; width: 0; min-width: 100%;
            margin: 0 0 var(--sp-3); font-size: var(--fs-sm); }
/* padding-block, not decoration: at --fs-sm the summary's own box is 20px and WCAG 2.2 SC
   2.5.8 puts the floor for a pointer target at 24. It is the full row wide, so height is the
   only axis that was short. */
.case-why > summary { color: var(--text-dim); padding-block: var(--sp-1); }
/* The rule sits on the list, not the disclosure, so it draws only what is revealed — a
   2px bar hanging under a closed summary marks nothing.
   No max-width, by decision: the reasons run the full width of the card. The 68ch that was
   here is the measure the prose blocks keep, and holding it left the text ending around 500px
   inside a 1321px card. A reason is a diagnostic line scanned for a resource name or an
   action, not a paragraph read through, which is what makes the trade a reasonable one. */
.case-why ul { list-style: none; margin: var(--sp-2) 0 0; padding: 0 0 0 var(--sp-3);
               border-left: 2px solid var(--border);
               color: var(--text-dim); overflow-wrap: anywhere; }
.case-why li + li { margin-top: var(--sp-1); }
/* The attempt numbers are the join back to the marks strip above — same face, so "#2" here and
   the second x up there read as the same run. */
.att { font-family: var(--font-data); font-size: var(--fs-xs); color: var(--text);
       white-space: nowrap; margin-right: var(--sp-1); }

/* By-case and by-configuration tables. The bar is what makes a dozen rows scannable; the
   number stays beside it, because a bar alone cannot be read off precisely and a rate of
   1/10 and 10/100 look identical drawn. */
.bench-table { width: 100%; border-collapse: collapse; font-size: var(--fs-base); }
/* No header rule here at all, deliberately. The shared th already sets the face, size,
   tracking, padding, band and border; this table restated four of those and each one slightly
   differently — --fs-xs against --fs-2xs, .06em tracking against .1em, a zero top padding that
   cropped the band — which is exactly why its header row looked like no other on the
   dashboard. The numeric columns keep their own rule below, and it finally MATCHES: headers()
   carries a class now, so th.num is a real selector rather than one that silently never fired.
   .bench-table th.num is (0,2,1) and out-specifies table[data-stack] th at (0,1,2), which is
   what the nowrap needs in order to hold. */
.bench-table td { vertical-align: middle; }
/* The bar is decorative once the number beside it is read; the fraction in the next column is
   the accessible statement of the same thing. */
/* padding-LEFT, not only right: two numeric columns side by side ran their headers together
   into one word ("ATTEMPTSCLEAN RUNS") with nothing between them. */
.bench-table th.num, .bench-table td.num { text-align: right;
                  font-variant-numeric: tabular-nums; color: var(--text-dim); white-space: nowrap; }
.bench-table td.rate { width: 46%; }
.rate-bar { display: inline-block; vertical-align: middle; width: calc(100% - 3.4rem); max-width: 22rem;
            height: .5rem; border-radius: var(--r-pill); background: var(--surface-2); overflow: hidden; }
.rate-fill { display: block; height: 100%; border-radius: var(--r-pill); }
.rate-ok { background: var(--mark-ok); }
.rate-warn { background: var(--mark-warning); }
.rate-bad { background: var(--mark-critical); }
/* nowrap unconditionally: the stacked cell sets overflow-wrap: anywhere so a long case id can
   break, and a percentage inherited it and split between the digits and the sign. "20" over
   "%" is not a smaller number, it is a broken one. */
.rate-num { display: inline-block; width: 3rem; text-align: right; white-space: nowrap;
            font-variant-numeric: tabular-nums; }
/* No scroll rule and no min-width here: these tables go through table(..., "cards"), so below
   40rem they become captioned cards like the incident list and there is nothing left to scroll.
   The first version hand-rolled the markup and had to invent a sideways nudge to cope. */
.bench-table code { white-space: nowrap; }
/* Below 46rem table[data-pairs] hangs each caption beside its value, so the column rules that
   made sense in a table stop applying: a 46% rate column and a bar sized against it mean
   nothing once the cell is a line of its own. Only the alignment needs saying — right-aligned
   numbers were pulling away from the captions they belong to, leaving a caption at the left
   edge and its value at the right with a hand-span of nothing between them. */
@container page (max-width: 46rem) {
  .bench-table td.num { text-align: left; padding-left: 6rem; }
  /* The bar is sized against its COLUMN above this breakpoint, and a column is what a paired
     cell no longer has: calc(100% - 3.4rem) against a 6rem hanging indent left it with no width
     to draw and the rate showed as a bare percentage. */
  .rate-bar { width: 5rem; }
  /* The number's fixed 3rem is a COLUMN alignment device — it keeps percentages ragging right
     under each other. Beside a hanging caption there is no column to align to, and the fixed
     width was just enough to push the number onto its own line under the bar. */
  .rate-num { width: auto; margin-left: .45rem; }
  /* nowrap keeps a case id whole in a column. In a card there is no column to keep it out of,
     and the longest ids simply ran past the edge — A01-crashloop-missing-config-key is 32
     characters against about 20 of room. */
  .bench-table code { white-space: normal; overflow-wrap: anywhere; }
}
`;
