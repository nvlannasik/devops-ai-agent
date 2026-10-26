import { cell, esc, fmtAgo, fmtInt, fmtPct, headers, table, timeTag } from "./html.js";
import { byCase, byConfig, spotChecks, suiteRuns, type BenchRun } from "./bench.js";
import { thrownAttempts } from "../bench/store.js";
import { ICON, badge, delta, section, statList } from "./parts.js";
import { layout } from "./layout.js";

// ---- Benchmark ------------------------------------------------------------------------------

// pass^k first and largest. The other two flatter: pass@k counts a case that succeeded once in
// five tries as a success, which is the number you quote when you want the agent to look good
// and the number that tells an on-call nothing. The page is ordered the way the design doc
// argues, not the way the numbers flatter.
const RATE_NOTE =
  "pass^k is every attempt passing. An agent right four times in five is not 80% useful — " +
  "it is an agent whose output has to be checked every time, which is most of the work it was " +
  "meant to remove.";

// Marks per attempt, in order, so a run reads as a shape rather than a number: "xxxx." is a
// flaky case that finally landed, "...x." is a good case that slipped once. Those are different
// problems and a single percentage hides which one you have.
const marks = (spec: string): string => {
  const failed = [...spec].filter((c) => c === "x").length;
  const glyphs = [...spec]
    // aria-hidden on every glyph: read one by one a screen reader says "black circle black
    // circle multiplication x", which is noise, not information. The strip carries one name.
    .map((c) => `<span class="${c === "x" ? "mk-fail" : "mk-pass"}" aria-hidden="true">${c === "x" ? "✕" : "●"}</span>`)
    .join("");
  // role="img" + a label, because this IS meaningful and had no text alternative — the shape
  // is the reason it exists, and the shape is exactly what is invisible to a screen reader.
  const label =
    failed === 0
      ? `all ${spec.length} attempts passed`
      : `${failed} of ${spec.length} attempts failed, in order: ${[...spec].map((c) => (c === "x" ? "fail" : "pass")).join(", ")}`;
  return `<span class="marks" role="img" aria-label="${esc(label)}">${glyphs}</span>`;
};

/** A case's failures, grouped by the reasons they give. Four attempts that failed for the same
 *  reason are one finding observed four times, not four findings — the real data has exactly
 *  that shape (A02 #1-#4, identical), and listing it per attempt is four copies of one line. */
function whyByCase(run: BenchRun): Map<string, { attempts: number[]; reasons: string[] }[]> {
  const out = new Map<string, { attempts: number[]; reasons: string[] }[]>();
  for (const f of run.failures) {
    const groups = out.get(f.case) ?? [];
    // Keyed on the reasons themselves with a separator no reason can contain, so "a; b" and
    // ["a", "b"] cannot collide into one group.
    const key = f.reasons.join("\u0000");
    const hit = groups.find((g) => g.reasons.join("\u0000") === key);
    if (hit) hit.attempts.push(f.attempt);
    else groups.push({ attempts: [f.attempt], reasons: f.reasons });
    out.set(f.case, groups);
  }
  return out;
}

function benchRunCard(run: BenchRun, open: boolean): string {
  const why = whyByCase(run);
  // Attempts that died before the model answered. They are scored as failures, which is right —
  // the run still did not work — but they measure the backend, not the agent, and the rate at the
  // top of this card silently mixes the two. Two of the seven recorded runs are affected: three
  // SQS timeouts in one, six `429 no credits` in another.
  const thrown = thrownAttempts(run.failures);
  // The union, not just the marks: a failure whose case is missing from marks would otherwise
  // be dropped silently, and this list is now the only place failures are reported.
  const cases = [...new Set([...Object.keys(run.marks), ...why.keys()])].sort();
  const axes = Object.entries(run.axes ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));

  // A <details>, newest open: twenty fully expanded runs made this page 5,000px of case lists
  // nobody reads past the first. The summary is the whole header, so a closed run still says
  // its score, its configuration and its axes — only the per-case detail folds away.
  return `<details class="card bench-run"${open ? " open" : ""}>
    <summary>
    <header class="bench-head">
      <div>
        <span class="bench-rate" title="every attempt passed">${fmtPct(run.passHatK, 1)}</span>
        <span class="meta">pass^${run.attempts}</span>
      </div>
      <div class="meta bench-sub">
        ${
          // With one attempt the three rates are the same number, and "pass@1 100% · pass@1
          // 100%" reads as a rendering bug rather than a single-attempt run.
          run.attempts === 1
            ? "one attempt each — not a measure of consistency"
            : `pass@1 ${fmtPct(run.pass1, 1)} · pass@${run.attempts} ${fmtPct(run.passK, 1)}`
        } ·
        ${fmtInt(run.cases)} case${run.cases === 1 ? "" : "s"} × ${fmtInt(run.attempts)}
      </div>
      <div class="meta">${timeTag(run.at)}</div>
      <span class="bench-toggle meta" aria-hidden="true"></span>
    </header>

    <div class="bench-meta meta">
      ${run.backends ? `<span translate="no">${esc(run.backends)}</span>` : ""}
      ${run.provider ? `<span class="badge">${esc(run.provider)}</span>` : ""}
      ${run.sha ? `<code translate="no">${esc(run.sha)}</code>` : ""}
      ${run.maxTokens ? `<span>MAX_TOKENS ${fmtInt(run.maxTokens)}</span>` : ""}
    </div>

    ${
      axes.length > 0
        ? `<div class="bench-axes">${axes
            .map(([name, [ok, seen]]) => badge(`${name} ${fmtInt(ok)}/${fmtInt(seen)}`, AXIS_TONE[rateLevel(ok, seen)]))
            .join("")}</div>`
        : ""
    }
    </summary>

    <div class="bench-body">
    ${
      // Text, not a tone alone: the caveat has to survive a reader who cannot see the colour,
      // and "don't convey information by colour alone" is the rule it would break. The badge
      // carries its own words and the sentence beside it names the cases.
      thrown.length > 0
        ? `<p class="bench-meta meta">${badge(`${fmtInt(thrown.length)} attempt${thrown.length === 1 ? "" : "s"} never answered`, "warning")}
            <span>died before the model replied (${esc(
              [...new Set(thrown.map((t) => t.case.split("-")[0]))].join(", ")
            )}) — infrastructure, not the agent. The rates above count them as failures.</span></p>`
        : ""
    }

    <ul class="bench-cases" role="list">
      ${cases
        // marks() returns the whole element now, labelled. Wrapping it again in a second
        // <span class="marks"> left an unlabelled one on the outside — which is the one a
        // screen reader reaches first.
        .map((c) => {
          const groups = why.get(c) ?? [];
          return (
            `<li role="listitem"><code translate="no">${esc(c)}</code>${marks(run.marks[c] ?? "")}` +
            (groups.length === 0
              ? ""
              // Closed by default, and the summary carries the count because that is what a
              // reader decides on: the marks strip already shows THAT attempts failed, so an
              // unlabelled triangle would make them open every row to find out how many.
              : `<details class="case-why"><summary>${fmtInt(
                  groups.reduce((n, g) => n + g.attempts.length, 0)
                )} failed attempt${groups.reduce((n, g) => n + g.attempts.length, 0) === 1 ? "" : "s"} — why</summary>` +
                `<ul role="list">${groups
                  .map(
                    (g) =>
                      `<li role="listitem"><span class="att">${g.attempts
                        .sort((a, b) => a - b)
                        .map((n) => `#${fmtInt(n)}`)
                        .join(" ")}</span> ${g.reasons.map((r) => esc(r)).join(" &middot; ")}</li>`
                  )
                  .join("")}</ul></details>`) +
            `</li>`
          );
        })
        .join("")}
    </ul>
    </div>
  </details>`;
}

// A rate as a bar. The number is already in the row; the bar is what makes twelve rows
// scannable, which is the whole reason k8s-ai-bench's task page has one.
/** ok / warn / bad for a pass rate. The bar draws it as a fill class and an axis draws it as a
 *  badge tone, so the two renderings share the threshold rather than each carrying a copy. */
const rateLevel = (passed: number, attempts: number): "ok" | "warn" | "bad" => {
  const pct = attempts ? Math.round((passed / attempts) * 100) : 0;
  return pct === 100 ? "ok" : pct >= 50 ? "warn" : "bad";
};
const AXIS_TONE = { ok: "ok", warn: "warning", bad: "critical" } as const;

const rateBar = (passed: number, attempts: number): string => {
  const pct = attempts ? Math.round((passed / attempts) * 100) : 0;
  const tone = rateLevel(passed, attempts);
  return (
    `<span class="rate-bar" role="img" aria-label="${pct}% of ${fmtInt(attempts)} attempts">` +
    `<span class="rate-fill rate-${tone}" style="width:${pct}%"></span></span>` +
    `<span class="rate-num">${pct}%</span>`
  );
};

// Worst first — the ordering is the point, not the table. Sorted best-first a benchmark tells
// you what already works.
//
// Built with table()/headers()/cell() like every other table on this dashboard rather than
// hand-rolled markup, which is what the first version of this page did. The helpers carry the
// role attributes and the per-cell data-label that let a table stop being a table below 46rem.
//
// "pairs", after two wrong answers. "cards" places cells by CLASS onto a three-column grid —
// its own comment warns that a table with different columns "would come apart under these
// rules", and under it these two did: the rate bar landed on top of the case name and no
// caption appeared at all. Plain "stack" fixed that but put every caption on its own line,
// which is the case its comment describes as doubling the table's height. "pairs" is the one
// written for "a record whose values are all short" — a case id, a rate, two counts.
function byCaseTable(history: BenchRun[]): string {
  const rows = byCase(history);
  if (rows.length === 0) return "";
  const body = rows
    .map(
      (r) =>
        `<tr role="row">` +
        cell("Case", `<code translate="no">${esc(r.id)}</code>`) +
        cell("Pass rate", rateBar(r.passed, r.attempts), "rate") +
        cell(
          "Attempts",
          `${fmtInt(r.passed)}/${fmtInt(r.attempts)}` +
            // Named, never silently dropped: a case whose credits ran out mid-run has a smaller
            // denominator than its siblings, and the row has to say so or the comparison lies.
            (r.excluded > 0
              ? ` <span class="meta" title="attempts that failed before the model answered — a backend error, not the agent">+${fmtInt(r.excluded)} n/a</span>`
              : ""),
          "num"
        ) +
        cell("Runs", fmtInt(r.runs), "num") +
        `</tr>`
    )
    .join("");
  return `${section(ICON.incidents, "By case", '<span class="meta">hardest first</span>')}
    ${table(headers("Case", "Pass rate", ["Attempts", "num"], ["Runs", "num"]), body, "pairs", "bench-table")}`;
}

/**
 * The subset runs — which the leaderboard and the run list both decline for the same reason, a
 * subset's pass@1 not being comparable to a suite's, and which still have to be visible somewhere
 * or `--filter` measures something nobody can find afterwards.
 *
 * Deliberately the smallest thing that answers "what did that spot check say": when, what it
 * covered, how many attempts passed. No pass@1, no pass^k, no rate bar — the bar is the visual the
 * comparable tables own, and lending it here is exactly what would make these rows read as their
 * peers. The filter is printed verbatim because it IS the scope: `^(B04|C08)` says more than
 * "2 cases", and it is what someone would paste to run it again.
 */
function spotCheckTable(history: BenchRun[]): string {
  const rows = spotChecks(history);
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => {
      const marks = Object.values(r.marks ?? {}).join("");
      const passed = [...marks].filter((m) => m !== "x").length;
      return (
        `<tr role="row">` +
        cell("When", timeTag(r.at)) +
        cell("Scope", `<code translate="no">${esc(r.filter ?? "")}</code>`) +
        cell("Cases", fmtInt(r.cases), "num") +
        cell("Attempts", `${fmtInt(passed)}/${fmtInt(marks.length)}`, "num") +
        `</tr>`
      );
    })
    .join("");
  // Folded: a spot check is looked up, not scanned — eighteen rows of them pushed the run list a
  // screen further down for a table whose own caption says not to compare it.
  return `${section(ICON.bench, "Spot checks", '<span class="meta">subset runs — counted by case above, never compared as scores</span>')}
    <details class="fold"><summary>${fmtInt(rows.length)} spot check${rows.length === 1 ? "" : "s"} <span class="meta">· latest ${timeTag(rows[0]!.at)}</span></summary>
    ${table(headers("When", "Scope", ["Cases", "num"], ["Attempts", "num"]), body, "pairs", "bench-table")}
    </details>`;
}

function byConfigTable(history: BenchRun[]): string {
  const rows = byConfig(history);
  if (rows.length === 0) return "";
  const body = rows
    .map(
      (r) =>
        `<tr role="row">` +
        cell(
          "Backends",
          `<span translate="no">${esc(r.backends)}</span>` +
            (r.provider ? ` <span class="badge">${esc(r.provider)}</span>` : "")
        ) +
        cell("Pass rate", rateBar(r.passed, r.attempts), "rate") +
        cell("Attempts", `${fmtInt(r.passed)}/${fmtInt(r.attempts)}`, "num") +
        cell("Clean runs", `${fmtInt(r.cleanRuns)}/${fmtInt(r.runs)}`, "num") +
        `</tr>`
    )
    .join("");
  const caption = rows.length === 1 ? "only one measured so far" : "best first";
  return `${section(ICON.bench, "By configuration", `<span class="meta">${caption}</span>`)}
    ${table(headers("Backends", "Pass rate", ["Attempts", "num"], ["Clean runs", "num"]), body, "pairs", "bench-table")}`;
}

/** The four figures a reader opens this page for, from the newest whole-suite run. */
function benchShelf(runs: BenchRun[]): string {
  const suite = suiteRuns(runs);
  const [last, prev] = suite;
  if (!last) return "";
  const cases = byCase(runs);
  const clean = cases.filter((c) => c.attempts > 0 && c.passed === c.attempts).length;
  const pct = (n: number) => n * 100;
  return statList([
    {
      icon: ICON.check,
      label: `pass^${last.attempts}`,
      value: fmtPct(last.passHatK, 1),
      sub: `latest run · ${fmtInt(last.cases)} cases × ${fmtInt(last.attempts)}, every attempt passing`,
      delta: prev ? delta(pct(last.passHatK), pct(prev.passHatK), { better: "higher", unit: "pp" }) : "",
    },
    {
      icon: ICON.bench,
      label: "pass@1",
      value: fmtPct(last.pass1, 1),
      sub: "latest run · first attempt passing",
      delta: prev ? delta(pct(last.pass1), pct(prev.pass1), { better: "higher", unit: "pp" }) : "",
    },
    {
      icon: ICON.incidents,
      label: "Cases always passing",
      value: `${fmtInt(clean)}/${fmtInt(cases.length)}`,
      sub: "every attempt across every run",
    },
    {
      icon: ICON.overview,
      label: "Suite runs",
      value: fmtInt(suite.length),
      sub: `last ${fmtAgo(last.at)} · ${fmtInt(spotChecks(runs).length)} spot checks besides`,
    },
  ]);
}

export function benchPage(input: BenchRun[], openIncidents?: number): string {
  // Sorted HERE, not trusted from the caller. The heading says "newest first", and a heading
  // that depends on someone else having sorted is a heading that will one day be wrong — the
  // first render of this page had them oldest-first while the label claimed otherwise.
  const runs = [...input].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  // The cards below are whole-suite runs only. A subset run's card would carry a pass@1 over two
  // cases beside one over twenty and invite the comparison the numbers cannot bear; the spot-check
  // table states the same run in the terms it can actually be read in.
  const cards = suiteRuns(runs);
  const body =
    cards.length === 0
      ? `<div class="card">
           <p class="meta">No benchmark runs stored yet.</p>
           <p class="meta">Runs are written by <code translate="no">npm run bench</code>, which appends a
             line to <code translate="no">bench/results/history.jsonl</code> and pushes it. This page reads
             that file out of the image, so a score recorded after this pod was built appears on the next
             build. See <code translate="no">bench/README.md</code>.</p>
         </div>`
      : cards.map((r, i) => benchRunCard(r, i === 0)).join("");

  return layout(
    "Benchmark",
    `<div class="doc">
     <p class="eyebrow">Agent</p>
     <h1>Benchmark</h1>
     <p class="meta">Synthetic incidents replayed through the real investigation path, scored on what the agent
       produced. pass^k first: it is the only rate that counts an answer you would not have to check.</p>
     ${benchShelf(runs)}
     <details class="fold about"><summary>How this is scored</summary>
     <p class="meta">${esc(RATE_NOTE)}</p>
     <p class="meta">Case ids and tiers are this repo's own
       (<code translate="no">docs/BENCHMARK_agent_stack.md</code>); the scenario shape and two of the
       three views below &mdash; overall pass rate by case, and the configuration leaderboard &mdash;
       are borrowed from <a href="https://github.com/gke-labs/k8s-ai-bench" rel="noreferrer noopener"
       target="_blank">k8s-ai-bench</a>. Its scoring is not: every one of its verifiers diffs cluster
       state, and this scores a written proposal. See <code translate="no">bench/README.md</code>.</p>
     <p class="meta">Three of the design doc's six axes are implemented — the remediation proposal,
       evidence grounding, and the facts the RCA text has to state. A run showing 100% is silent
       about the other three.</p>
     </details>
     ${byCaseTable(runs)}
     ${byConfigTable(runs)}
     ${spotCheckTable(runs)}
     ${section(ICON.overview, "Runs", '<span class="meta">newest first · older runs fold to their score</span>')}
     ${body}
     </div>`,
    { current: "/bench", openIncidents }
  );
}
