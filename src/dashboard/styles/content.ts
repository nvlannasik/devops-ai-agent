// Part of STYLES (../styles.ts): the RCA, skills, rendered markdown, filter chips, empty states and the pager. A template literal — read the rules in styles.ts first.
export const CONTENT_CSS = `
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
/* --sp-8, not --sp-7: the scale is 1,2,3,4,5,6,8,10,12 and deliberately has no 7, so the
   original resolved to nothing and these sections had NO top margin — only the padding
   below carried them apart. Invisible in the CSS, because a var() typo reads exactly like
   a var() that works. */
.rca-sec + .rca-sec { margin-top: var(--sp-8); padding-top: var(--sp-6); border-top: 1px solid var(--border); }
/* A section that opens with a sentence and then tabulates (renderBody's lead) is the one
   adjacency in the RCA that no heading separates: the last line of the lead and the table's
   header row would otherwise sit a single line apart and read as a caption the table swallowed. */
.rca-sec > .prose + .table-wrap { margin-top: var(--sp-5); }
/* Severity and Confidence are stated inline in the RCA text, and the model writes a sentence
   after the confidence level that exists nowhere else — the incidents table has the level and
   not the reasoning. So they are rendered, and rendered small: the badges at the top of the
   page are where those values are read, this is where they are explained. */
/* A GRID, not a wrapping flex row, and the difference is what a reader sees. As flex peers the
   two fields sized themselves from their own content: Severity is one word and measured 94px,
   Confidence is a word plus the sentence explaining it and measured 647px, so they sat side by
   side at wildly different widths with the labels landing nowhere near each other. They are a
   field LIST — the same label, different values — so the labels take one column and the values
   another, and the two rows line up whatever either one holds. */
.rca-fields {
  display: grid; grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--sp-2) var(--sp-4);
  margin: 0 0 var(--sp-5);
}
/* The div exists because a dl wants its pairs grouped; display:contents removes its box so the dt
   and dd become grid items of the strip itself. Without it every pair is one cell and the
   columns never align — which is the whole point of the grid. */
.rca-fields > div { display: contents; }
.rca-fields dt {
  font-family: var(--font-data); font-size: var(--fs-2xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .12em; color: var(--text-dim); white-space: nowrap;
  /* The label is small caps against a value at --fs-base, so its box is shorter: without this
     it hangs above the first line of a value that wraps to three. */
  line-height: 1.6;
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
/* A Runbook writes one command per fence, so a step's commands arrive as a run of blocks. Drawn
   apart, they read as unrelated excerpts; joined, they read as one terminal session. */
.rca-code:has(+ .rca-code) { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.rca-code + .rca-code { margin-top: 0; padding-top: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
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
/* content-box: the floor is for the WORD. Under the global border-box, the cell's 35px of
   padding came out of those 12ch and "Immediate" still broke as "Immediat/e" (measured 2026-09-28:
   a 104px cell, a 69px line). */
.rca td.primary { min-width: 12ch; box-sizing: content-box; }
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
/* ---------- rendered markdown (the prompt and skill pages) ---------- */
/* The prompt and every skill are markdown files, and they used to render inside a pre block — so a
   reader saw the asterisks and backticks rather than what they mean. markdown.ts renders a
   subset of CommonMark sized to what those files actually contain; this is what it lands in.

   IT DECLARES NO FONT SIZE, and that is the point rather than an omission. It used to set
   --fs-md (17px), copied from the RCA's prose on the argument that both are long-form text —
   but the RCA is the whole content of its own page, while this sits in a card among page
   furniture whose paragraphs are 13px and whose body is 15px. A 17px block inside a 15px page
   reads as a different typographic system, which is exactly what it looked like. Inheriting
   means it cannot drift from the page again; the only thing stated here is the LEADING, which
   a 24,000-character document earns and the page's 1.55 does not give it. */
.md { line-height: 1.7; color: var(--text); }
.md > * + * { margin-top: var(--sp-4); }
.md h3, .md h4, .md h5 { line-height: 1.35; margin-top: var(--sp-6); }
/* The RCA page already learned this one and this file repeated it: --fs-base is SMALLER than
   the --fs-md body below it, so every ## in the prompt rendered as a heading you had to be
   told was one. A heading may match its body's size and rank by weight and space; it may never
   be smaller. */
/* Stepping up from the inherited --fs-base, never down: a heading smaller than its own
   paragraph is the mistake the RCA page already made and wrote down. */
.md h3 { font-size: var(--fs-lg); font-weight: 650; }
.md h4 { font-size: var(--fs-md); font-weight: 650; letter-spacing: -.005em; }
/* The third level stops competing on size and takes case instead — a prompt's ### is a label
   inside a section, not another section. Smaller than the body on purpose, and NOT the mistake
   above: this is the same treatment the page's own h2 takes (11px mono, uppercase, tracked), so
   it reads as a label because of its case and tracking rather than in spite of its size. */
.md h5 {
  font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: .08em;
  color: var(--text-dim);
}
/* First child never pushes the block away from the heading above the whole document. */
.md > :first-child { margin-top: 0; }
.md ul, .md ol { margin: 0; padding-left: 1.35em; display: flex; flex-direction: column; gap: var(--sp-2); }
/* A nested list is a child of the <li> list, so it needs its own top gap and no bullet reset. */
.md ul ul, .md ol ol, .md ul ol, .md ol ul { margin-top: var(--sp-2); }
.md li { overflow-wrap: anywhere; }
/* Inline code is a tool name, an env var, a selector — data, in the data face, and marked as a
   run rather than a box: fifty boxed spans in a prompt is a page of confetti. */
.md code {
  font-family: var(--font-data); font-size: .9em;
  background: var(--surface-2); border-radius: 4px; padding: .1em .32em;
  overflow-wrap: anywhere;
}
/* A fenced block is a query an operator retypes, so it scrolls rather than wraps: a LogQL
   selector broken across lines is a selector that no longer says what it selects. */
.md pre.md-code {
  font-family: var(--font-data); font-size: var(--fs-sm); line-height: 1.55;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r);
  padding: var(--sp-4); margin: 0; overflow-x: auto;
}
.md pre.md-code code { background: none; padding: 0; font-size: inherit; }
.md strong { font-weight: 650; }
/* The postmortem Timeline: the time column holds one fixed-width timestamp, so it shrinks to it
   and the event column gets the rest instead of an even split. */
.pm-doc .md .table-wrap td:first-child, .pm-doc .md .table-wrap th:first-child { white-space: nowrap; width: 1%; }

.skill-body, .mem-pre {
  font-family: var(--font-data); font-size: var(--fs-sm); line-height: 1.6;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r);
  padding: var(--sp-5); margin: 0;
  white-space: pre-wrap; overflow-wrap: anywhere;
}

/* /memory: recall text keeps its line breaks; a conversation's text wraps anywhere (tokens, ids). */
.mem-pre + .mem-pre { margin-top: var(--sp-3); }
.mem-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.mem-dim { color: var(--text-dim); overflow-wrap: anywhere; }
.mem-text + p, .mem-text + .mem-text { margin-top: var(--sp-2); }

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
/* The actions an incident offers sit to the right of its badges as buttons — outlined, so they
   rank below the page's one primary control (Apply filters) and above body links. */
.page-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-left: auto; }
.page-actions a.standalone {
  display: inline-flex; align-items: center; min-height: 2.25rem; padding: 0 var(--sp-3);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface-raised);
  color: var(--text); font-size: var(--fs-sm); box-shadow: var(--shadow-sm);
}
.page-actions a.standalone:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
/* A list page's title row: the heading and its count on the left, the view switch on the right. */
.page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3) var(--sp-6); margin-bottom: var(--sp-5); }
.page-head h1 { margin-bottom: var(--sp-1); }
.page-head strong { color: var(--text); font-weight: 600; }
.seg-count {
  display: inline-block; min-width: 1.4em; margin-left: .35em; padding: 0 .4em; border-radius: var(--r-pill);
  background: var(--tint-critical); color: var(--critical); font-size: var(--fs-2xs); font-weight: 700; text-align: center;
}
/* A remediation's params: key and value on one line each, the key dimmed. */
dl.kv { margin: var(--sp-1) 0 0; display: grid; gap: 2px; font-size: var(--fs-sm); }
dl.kv > div { display: flex; flex-wrap: wrap; gap: 0 .5em; }
dl.kv dt { color: var(--text-dim); }
dl.kv dt::after { content: " ="; }
dl.kv dd { margin: 0; overflow-wrap: anywhere; }
`;
