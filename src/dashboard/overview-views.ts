import { costUsd, type Price } from "../agent/llm/pricing.js";
import { cell, esc, fmtDuration, fmtInt, fmtPct, headers, table, timeTag } from "./html.js";
import { incidentSummary } from "./rca.js";
import { donutChart, lineChart } from "./chart.js";
import type { IncidentRow, Overview, Tokens } from "./queries.js";
import { ICON, breakable, costCell, delta, empty, fmtUsd, section, severityBadge, statList, stateBadge, tone, toneAttr } from "./parts.js";
import { WINDOW_LABEL, layout, rangeControl } from "./layout.js";


// Every cell carries a class, including the two that hold nothing but a badge. Below 46rem the
// stylesheet stops laying this out as a table and lays each row out as a card instead, and it
// addresses the cells by name to do it — a positional selector would silently re-target the day
// someone inserts a column, which is the kind of break no test written against the columns as a
// SET would catch.
export function incidentTable(rows: IncidentRow[], whenEmpty: string, now: Date = new Date()): string {
  if (rows.length === 0) return whenEmpty;
  const body = rows
    .map(
      (r) => `<tr role="row"${toneAttr(r.severity)}>
      <td role="cell" class="when">${timeTag(r.created_at, now)}</td>
      <td role="cell" class="primary"><a href="/incidents/${esc(r.id)}">${breakable(r.alertname)}</a>${
        r.root_cause ? `<div class="sub summary">${incidentSummary(r.root_cause)}</div>` : ""
      }</td>
      <td role="cell" class="ns mono" translate="no">${esc(r.namespace ?? "—")}</td>
      <td role="cell" class="sev">${severityBadge(r.severity)}</td>
      <td role="cell" class="state">${stateBadge(r.resolved_at)}</td>
    </tr>`
    )
    .join("");
  return table(headers("When", "Alert", "Namespace", "Severity", "State"), body, "cards");
}

// What the investigations cost. The stats are totals over the window; the table is per
// backend AND model, because under the router "which model did that" is the question — a
// heavy backend answering what a light one could have is the finding this section exists for.
function tokenUsage(t: Tokens, prices: ReadonlyMap<string, Price> = new Map()): string {
  if (t.calls === 0) {
    return empty(
      "No LLM calls recorded in this window.",
      "Accounting starts with the next investigation the agent runs.",
      ICON.chip
    );
  }
  // Six columns is the widest table on the site, and the two that fall off a phone first are
  // Output and Cache read — the halves of the ratio this section exists to show. Stacked, a
  // backend's whole accounting is one captioned block.
  const rows = t.byBackend
    .map(
      (b) => `<tr role="row">` +
        cell("Backend", esc(b.backend), "primary") +
        cell("Model", `<span translate="no">${esc(b.model)}</span>`, "mono") +
        cell("Calls", fmtInt(b.calls), "num") +
        cell("Input", fmtInt(b.input), "num") +
        cell("Output", fmtInt(b.output), "num") +
        cell("Cache read", fmtInt(b.cacheRead), "num") +
        cell("Cost", costCell(prices, b), "num") +
        `</tr>`
    )
    .join("");
  // Only the priced backends add up — an unpriced one is not $0, so the total says what it covers.
  const priced = t.byBackend.map((b) => costUsd(prices.get(b.backend), b)).filter((c): c is number => c !== null);
  const total = priced.length ? ` · ${fmtUsd(priced.reduce((a, b) => a + b, 0))} on priced backends` : "";
  return (
    statList(
      [
        // The call count rides in the sub-line rather than taking a fifth tile: it is the
        // denominator of the figure above it ("how much, over how many calls"), and as its own
        // tile it was the odd one out on a four-wide shelf — a count of events among three
        // counts of tokens.
        { icon: ICON.layers, label: "Total tokens", value: fmtInt(t.input + t.output), sub: `input + output over ${fmtInt(t.calls)} calls${total}` },
        // The split, not just the two counts. An investigation that is 95% input is a caching
        // problem; one that is 40% output is a verbosity problem. The shares say which.
        { icon: ICON.inTokens, label: "Input", value: fmtInt(t.input), sub: `${fmtPct(t.input, t.input + t.output)} of tokens` },
        { icon: ICON.outTokens, label: "Output", value: fmtInt(t.output), sub: `${fmtPct(t.output, t.input + t.output)} of tokens` },
        // Cache reads are the tokens that were NOT re-sent, so the pair reads as a saving
        // and its price. Writes sit in the sub-line: you pay for them once, deliberately.
        { icon: ICON.bolt, label: "Cache reads", value: fmtInt(t.cacheRead), sub: `${fmtInt(t.cacheCreation)} written` },
      ]
    ) +
    table(
      headers("Backend", "Model", "Calls", "Input", "Output", "Cache read", "Cost"),
      rows,
      "pairs"
    )
  );
}

// `now` is the instant the response is being built, taken once by the caller and threaded
// through every relative timestamp on the page. Defaulted so a test (and any caller that does
// not care) needs no argument — but passing ONE value is what keeps thirty rows internally
// consistent: computed per row, a list rendered across a minute boundary would say "1h ago"
// and "59m ago" about two incidents a second apart.
export function overviewPage(
  o: Overview,
  recent: IncidentRow[],
  now: Date = new Date(),
  openIncidents?: number,
  prices: ReadonlyMap<string, Price> = new Map()
): string {
  const remediationTotal = o.remediationSucceeded + o.remediationFailed;
  const feedbackTotal = Object.values(o.feedback).reduce((a, b) => a + b, 0);

  // The figure this panel used to report was `status = succeeded` over all remediations — which
  // is how many MCP calls did not error, NOT how many fixes worked. A restart that returns 200
  // and changes nothing scored as a success. The verdicts are the answer to the question the
  // tile was already appearing to ask, so the tile now reports them; the call counts survive in
  // the sub-line, where they are what they always were — a fact about the API, not the cluster.
  const recovered = o.verdicts.recovered ?? 0;
  const unchanged = o.verdicts.unchanged ?? 0;
  const worse = o.verdicts.worse ?? 0;
  const inconclusive = o.verdicts.inconclusive ?? 0;
  // The denominator is checks that REACHED a verdict. A pending check is not a failure and
  // not a success; counting it as either moves the percentage for a reason nobody did.
  const verdicts = recovered + unchanged + worse + inconclusive;

  const topRecurring = Math.max(1, ...o.recurring.map((r) => r.n));
  const recurring =
    o.recurring.length === 0
      ? empty("Nothing has recurred.", `Every alert in the last ${WINDOW_LABEL[o.range]} fired exactly once.`, ICON.repeat)
      : table(
          headers("Alert", "Namespace", "Times", "Last seen"),
          o.recurring
            .map(
              (r) => `<tr role="row">` +
                // The alert name is a link into the list filtered to it. It is the one obvious
                // question this table raises — "show me those twelve" — and before this the
                // answer was to read the name, go to Incidents, and type it back in.
                cell(
                  "Alert",
                  // Both layers, the same pair detailPage's Slack link takes: encodeURIComponent
                  // makes the value safe INSIDE the URL (a stray & cannot open a second query
                  // parameter), esc makes the whole string safe inside the attribute.
                  `<a href="${esc(`/incidents?alertname=${encodeURIComponent(r.alertname)}`)}">${breakable(r.alertname)}</a>`,
                  "primary"
                ) +
                cell("Namespace", `<span translate="no">${esc(r.namespace ?? "—")}</span>`, "mono") +
                // A ranking bar against the most frequent alert — it says "twice as often", which
                // the bare count makes the reader work out.
                cell(
                  "Times",
                  `${fmtInt(r.n)}<span class="ratio under" style="--a:${Math.round((r.n / topRecurring) * 100)}" aria-hidden="true"><span></span></span>`,
                  "num"
                ) +
                cell("Last seen", timeTag(r.last_seen, now), "when") +
                `</tr>`
            )
            .join(""),
          "pairs"
        );

  // The severity mix, and what came back from the humans who read the RCAs. Two figures of the
  // same kind — what the window turned out to BE — set beside the ring that shows the first of
  // them. The on-call numbers moved here from the state shelf when MTTR took their place on it:
  // a reply is not the state of an incident, it is an outcome, and this is the outcomes panel.
  const severitySlices = o.severity.map((r) => ({
    label: r.severity,
    value: r.n,
    // The last dead end on this panel. A severity IS a filter the list already has a field
    // for, so following one lands on a page that explains itself — the Severity select comes
    // up set to the value that was clicked.
    href: `/incidents?severity=${encodeURIComponent(r.severity)}`,
    // Through the same allowlist every other tone on the page goes through. A typo in an alert
    // rule, or a severity label this dashboard has never seen, draws in the neutral stroke
    // rather than being passed into an attribute selector that would not match it anyway.
    tone: tone(r.severity),
  }));

  // State first, then volume, then cost. The panel across the top is where the page answers the
  // only question that can need an answer right now — how many are still open — and it answers
  // it in the first line of the page rather than below a chart. It carries the page's single
  // toned figure: open incidents wear the critical spine when there are any, and nothing else on
  // the shelf is coloured, so the tone means "look here" and not "this tile is a stat".
  //
  // The hero below it is one composed object and nothing else: the 30-day count set against the
  // weekly series it summarises, because the count and the shape of it are one fact. The outcome
  // figures used to sit in a section of their own between the two; they are the state of those
  // incidents, so they belong in the state panel, and repeating them in both places would make
  // the page say the same thing twice.
  const open = o.totalIncidents - o.resolvedIncidents;
  const resolvedPct = o.totalIncidents ? (o.resolvedIncidents / o.totalIncidents) * 100 : null;
  const prevResolved = o.prev.totalIncidents
    ? ((o.prev.totalIncidents - o.prev.openIncidents) / o.prev.totalIncidents) * 100
    : null;
  return layout(
    "Overview",
    // One block: laid into <main> as three children, main > * + * spaced the title from its own
    // caption like two unrelated sections.
    `<div class="doc">
       <p class="eyebrow">Monitor</p>
       <h1>Overview</h1>
       <p class="meta">What the agent investigated in the last ${esc(WINDOW_LABEL[o.range])}, and how it went.</p>
     </div>
     ${statList(
       [
         {
           icon: ICON.incidents, label: "Open", value: fmtInt(open),
           sub: `of ${fmtInt(o.totalIncidents)} investigated`,
           tone: open > 0 ? "critical" : undefined,
           delta: delta(open, o.prev.openIncidents, { better: "lower" }),
           // The tile and the list are the same fact at two zoom levels, so the tile is the way
           // in. This is the page's most-wanted next step: the reader who sees a count of open
           // incidents wants to know WHICH.
           href: "/incidents?resolved=false",
           hrefLabel: `Open — see the ${fmtInt(open)} incidents still firing`,
         },
         {
           icon: ICON.check, label: "Resolved", value: fmtPct(o.resolvedIncidents, o.totalIncidents),
           sub: `${o.resolvedIncidents} of ${o.totalIncidents}`,
           delta: delta(resolvedPct, prevResolved, { better: "higher", unit: "pp" }),
           href: "/incidents?resolved=true",
           hrefLabel: `Resolved — see the ${fmtInt(o.resolvedIncidents)} incidents that closed`,
         },
         // The figure this dashboard existed for a year without: how long an incident stays
         // open. Everything else on the shelf counts incidents; this one is the only tile that
         // says anything about how well they are being handled.
         {
           icon: ICON.repeat, label: "Mean time to resolve", value: fmtDuration(o.mttrMs),
           sub: `over ${fmtInt(o.resolvedIncidents)} resolved`,
           delta: delta(o.mttrMs, o.prev.mttrMs, { better: "lower", unit: "duration" }),
         },
         {
           icon: ICON.wrench, label: "Remediation verified", value: fmtPct(recovered, verdicts),
           sub: `${fmtInt(recovered)} of ${fmtInt(verdicts)} recovered · ${fmtInt(o.remediationSucceeded)} of ${fmtInt(remediationTotal)} calls succeeded`,
           // A single remediation that left the workload worse outranks whatever the percentage
           // says. The tone is what makes the tile impossible to skim past; the count is in the
           // outcomes panel below.
           tone: worse > 0 ? "critical" : undefined,
         },
       ]
     )}
     <section class="hero">
       <div class="hero-body">
         <p class="hero-figure">
           <span class="hero-value">${esc(fmtInt(o.totalIncidents))}</span>
           <span class="hero-unit">investigated</span>
         </p>
         <div class="hero-chart">${lineChart(o.weekly, { label: `incidents ${o.seriesUnit}` })}</div>
       </div>
     </section>
     ${section(ICON.layers, "Outcomes")}
     <div class="split">
       <section class="card">
         <p class="eyebrow">By severity</p>
         ${donutChart(severitySlices, { label: "incidents by severity" })}
       </section>
       <section class="card">
         <p class="eyebrow">On-call feedback</p>
         ${statList(
           [
             {
               icon: ICON.speech, label: "Replies", value: fmtInt(feedbackTotal),
               sub: `${fmtInt(o.feedback.resolved ?? 0)} confirmed fixed`,
               delta: delta(feedbackTotal, o.prev.feedbackTotal, { better: "higher" }),
             },
             // Not "failed" — that was the call erroring, and it is in the tile above. This is
             // the workload ending up WORSE after a change the agent proposed, which is the most
             // consequential thing this system can do and had no representation on the page at
             // all. It keeps its place even at zero: a reader has to be able to see that the
             // answer is none, rather than infer it from an absence.
             {
               icon: ICON.wrench, label: "Made it worse", value: fmtInt(worse),
               sub: `${fmtInt(unchanged)} not fixed · ${fmtInt(inconclusive + o.verdictsPending)} unverified`,
               tone: worse > 0 ? "critical" : undefined,
               // Only when there are any. A tile reading zero has nothing to show, and a link
               // to an empty list is the dead end this was supposed to stop being.
               ...(worse > 0
                 ? {
                     href: "/incidents?verdict=worse",
                     hrefLabel: `Made it worse — see the ${fmtInt(worse)} incidents a remediation left worse`,
                   }
                 : {}),
             },
           ],
           "pair"
         )}
       </section>
     </div>
     ${section(ICON.chip, "Token usage")}
     ${tokenUsage(o.tokens, prices)}
     ${section(ICON.repeat, "Most recurring")}
     ${recurring}
     ${section(ICON.incidents, "Recent incidents", `<a class="standalone" href="/incidents">All incidents →</a>`)}
     ${incidentTable(recent, empty("No incidents yet.", "The agent posts here once it has investigated its first alert.", ICON.incidents), now)}`,
    {
      current: "/",
      tools: rangeControl(o.range),
      // The overview is the page someone leaves open on a second monitor, so it refreshes
      // itself. A <meta> refresh rather than a script: the CSP sends no script-src on this
      // route, and a full re-request is also what re-runs the queries — a fetch would need an
      // endpoint that does not exist. It discards nothing, because there is nothing on this
      // page to discard: no form, no scroll position worth keeping, no selection.
      refresh: true,
      openIncidents,
    }
  );
}
