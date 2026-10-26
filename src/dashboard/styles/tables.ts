// Part of STYLES (../styles.ts): tables, badges, filters, sign-in and prose. A template literal — read the rules in styles.ts first.
export const TABLES_CSS = `
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
td .sub, p.sub { color: var(--text-dim); font-size: var(--fs-sm); margin-top: 2px; overflow-wrap: anywhere; }
/* An incident row's summary is the symptom (incidentSummary in rca.ts), and it is a preview, not
   the finding: two lines, then the row ends. Unclamped, one causal chain made a row 300px tall. */
td .summary {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
  overflow: hidden;
}
/* A namespace is a label, and bench-a01 broken at its hyphen reads as two of them. The card
   layout below already says the same thing for phones. */
td.ns { white-space: nowrap; }
/* A skill's trigger is a regex: one long token with nowhere a line may break, so it may break
   anywhere — otherwise it claims the table's width and pushes the skill's name and description
   into a sliver. The size is a figure and a unit, and never splits between them. */
td.trigger code { overflow-wrap: anywhere; }
td.size { white-space: nowrap; }
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

/* ---------- people (/people) ---------- */
/* A member is a face and a name, the way every SaaS member list reads: an initials avatar in the
   KPI chip's own brand tint (no image — the CSP has no img-src for Slack's CDN, and a second
   origin per row is not worth a picture), the name at full weight, title/handle/id under it. */
.person { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.avatar {
  flex: 0 0 auto; display: grid; place-items: center;
  width: 2.25rem; height: 2.25rem; border-radius: 50%;
  background: var(--brand-tint); color: var(--accent);
  font-size: var(--fs-xs); font-weight: 700; letter-spacing: .04em;
}
.person-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.person-text strong { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.person-text .meta { overflow-wrap: anywhere; }
tr:has(.person) > td { vertical-align: middle; }
.roles { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
/* Approve share of a member's decisions. The track is the rejections and stays neutral: a reject
   is the gate working, not a failure, so it gets no tone. */
.ratio {
  display: block; width: 100%; max-width: 10rem; height: 6px; margin-bottom: var(--sp-1);
  border-radius: var(--r-pill); background: var(--surface-2); overflow: hidden;
}
.activity { display: block; font-size: var(--fs-sm); color: var(--text-dim); white-space: nowrap; }
.ratio > span { display: block; height: 100%; width: calc(var(--a, 0) * 1%); background: var(--accent); border-radius: inherit; }
`;
