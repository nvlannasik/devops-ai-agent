import { costUsd, type Price } from "../agent/llm/pricing.js";
import { cell, esc, fmtCompact, fmtDuration, fmtInt, fmtPct, headers, table, timeTag } from "./html.js";
import { incidentSummary } from "./rca.js";
import { lineChart, shareBar } from "./chart.js";
import type { IncidentRow, Overview, Tokens } from "./queries.js";
import { ICON, breakable, cardHead, costCell, delta, empty, fmtUsd, pageHead, severityBadge, statList, stateBadge, tone, toneAttr } from "./parts.js";
import { WINDOW_LABEL, layout, liveNote, rangeControl } from "./layout.js";


// Every cell carries a class, including the two that hold nothing but a badge. Below 46rem the
// stylesheet stops laying this out as a table and lays each row out as a card instead, and it
// addresses the cells by name to do it — a positional selector would silently re-target the day
// someone inserts a column, which is the kind of break no test written against the columns as a
// SET would catch.
/** `showCluster`: multi-cluster only — a Cluster column after the alert (agent/cluster). */
export function incidentTable(rows: IncidentRow[], whenEmpty: string, now: Date = new Date(), showCluster = false): string {
  if (rows.length === 0) return whenEmpty;
  const body = rows
    .map(
      (r) => `<tr role="row"${toneAttr(r.severity)}>
      <td role="cell" class="when">${timeTag(r.created_at, now)}</td>
      <td role="cell" class="primary"><a href="/incidents/${esc(r.id)}">${breakable(r.alertname)}</a>${
        r.root_cause ? `<div class="sub summary">${incidentSummary(r.root_cause)}</div>` : ""
      }</td>${showCluster ? `
      <td role="cell" class="cluster mono" data-label="Cluster" translate="no">${esc(r.cluster ?? "—")}</td>` : ""}
      <td role="cell" class="ns mono" translate="no">${esc(r.namespace ?? "—")}</td>
      <td role="cell" class="sev">${severityBadge(r.severity)}</td>
      <td role="cell" class="state">${stateBadge(r.resolved_at)}</td>
    </tr>`
    )
    .join("");
  const head = showCluster ? headers("When", "Alert", "Cluster", "Namespace", "Severity", "State") : headers("When", "Alert", "Namespace", "Severity", "State");
  return table(head, body, "cards");
}

// Only the priced backends add up — an unpriced one is not $0, so the total says what it covers.
function pricedTotal(t: Tokens, prices: ReadonlyMap<string, Price>): string {
  const priced = t.byBackend.map((b) => costUsd(prices.get(b.backend), b)).filter((c): c is number => c !== null);
  return priced.length ? `${fmtUsd(priced.reduce((a, b) => a + b, 0))} on priced backends` : "";
}

// What the investigating cost, as one panel: the total, how it split, what the cache saved.
// The total is abbreviated because a third of a row is not where a ten-digit figure fits; the
// exact count is the line directly under it, so nothing is rounded away.
function tokenCard(t: Tokens, prices: ReadonlyMap<string, Price>): string {
  if (t.calls === 0) {
    return empty(
      "No LLM calls recorded in this window.",
      "Accounting starts with the next investigation the agent runs.",
      ICON.chip
    );
  }
  const total = t.input + t.output;
  const cost = pricedTotal(t, prices);
  return (
    `<p class="figure"><b>${esc(fmtCompact(total))}</b>` +
    `<span>${esc(`${fmtInt(total)} tokens over ${fmtInt(t.calls)} calls`)}</span></p>` +
    // The split, not just the two counts. An investigation that is 95% input is a caching
    // problem; one that is 40% output is a verbosity problem. The shares say which.
    shareBar(
      [
        { label: "Input", value: t.input, tone: "", lead: true, display: `${fmtCompact(t.input)} · ${fmtPct(t.input, total)}` },
        { label: "Output", value: t.output, tone: "", display: `${fmtCompact(t.output)} · ${fmtPct(t.output, total)}` },
      ],
      { label: "tokens by direction" }
    ) +
    // Cache reads are the tokens that were NOT re-sent, so the pair reads as a saving and its
    // price: you pay for a write once, deliberately.
    `<p class="meta">${esc(
      `${fmtCompact(t.cacheRead)} cache reads · ${fmtCompact(t.cacheCreation)} written` + (cost ? ` · ${cost}` : "")
    )}</p>`
  );
}

// Per backend AND model, because under the router "which model did that" is the question — a
// heavy backend answering what a light one could have is the finding this table exists for.
// Seven columns is the widest table on the site, and the two that fall off a phone first are
// Output and Cache read; stacked ("pairs"), a backend's whole accounting is one captioned block.
function tokenTable(t: Tokens, prices: ReadonlyMap<string, Price>): string {
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
  return table(headers("Backend", "Model", "Calls", "Input", "Output", "Cache read", "Cost"), rows, "pairs");
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

  // Rows, not a table: the panel is a third of the page wide, and what a reader wants from it
  // is the ranking — which alert, how many times — with where and when as the line under it.
  const recurring =
    o.recurring.length === 0
      ? empty("Nothing has recurred.", `Every alert in the last ${WINDOW_LABEL[o.range]} fired exactly once.`, ICON.repeat)
      : `<ol class="rank">` +
        o.recurring
          .map(
            (r) => `<li><div>` +
              // The alert name is a link into the list filtered to it. It is the one obvious
              // question this panel raises — "show me those twelve" — and before this the answer
              // was to read the name, go to Incidents, and type it back in.
              // Both layers, the same pair detailPage's Slack link takes: encodeURIComponent
              // makes the value safe INSIDE the URL (a stray & cannot open a second query
              // parameter), esc makes the whole string safe inside the attribute.
              `<a href="${esc(`/incidents?alertname=${encodeURIComponent(r.alertname)}`)}">${breakable(r.alertname)}</a>` +
              `<span class="rank-sub"><span translate="no">${esc(r.namespace ?? "—")}</span> · ${timeTag(r.last_seen, now)}</span>` +
              `</div>` +
              `<span class="rank-n">×${fmtInt(r.n)}<span class="sr-only"> times</span></span></li>`
          )
          .join("") +
        `</ol>`;

  // The severity mix, and what came back from the humans who read the RCAs. Two figures of the
  // same kind — what the window turned out to BE — in one panel, the bar that shows the first of
  // them over the pair that states the second. The on-call numbers are here rather than on the
  // state shelf: a reply is not the state of an incident, it is an outcome.
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

  // The page, top to bottom: the title row with the controls that govern the whole page; the
  // state shelf, which answers the only question that can need an answer right now — how many
  // are still open — in the first line of data; the window's count over the series it
  // summarises, one fact in one frame at the full width of the page; then three panels abreast
  // (how the incidents split and what on-call said, which ones keep coming back, what the
  // investigating cost); and the two tables, each inside a card that names itself.
  //
  // The shelf carries the page's toned figures: open incidents wear the critical tone when
  // there are any, so the tone means "look here" and not "this tile is a stat".
  const open = o.totalIncidents - o.resolvedIncidents;
  const resolvedPct = o.totalIncidents ? (o.resolvedIncidents / o.totalIncidents) * 100 : null;
  const prevResolved = o.prev.totalIncidents
    ? ((o.prev.totalIncidents - o.prev.openIncidents) / o.prev.totalIncidents) * 100
    : null;
  return layout(
    "Overview",
    `${pageHead({
      eyebrow: "Monitor",
      title: "Overview",
      lede: `What the agent investigated in the last ${WINDOW_LABEL[o.range]}, and how it went.`,
      // The range governs every figure below it and the note says how fresh they are, so both
      // sit in the title row rather than in the chrome: they are about this page, not the site.
      tools: liveNote() + rangeControl(o.range),
    })}
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
           // The headline figure of the page: what is firing is what a reader opened it to learn.
           lead: true,
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
     <section class="card chart-card">
       <header class="chart-head">
         <p class="figure"><b>${esc(fmtInt(o.totalIncidents))}</b><span>incidents investigated</span></p>
         <span class="chart-window">last ${esc(WINDOW_LABEL[o.range])} · ${esc(o.seriesUnit)}</span>
       </header>
       ${lineChart(o.weekly, { label: `incidents ${o.seriesUnit}` })}
     </section>
     <div class="panels">
       <section class="card">
         ${cardHead("Outcomes")}
         ${shareBar(severitySlices, { label: "incidents by severity" })}
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
       <section class="card">
         ${cardHead("Token usage")}
         ${tokenCard(o.tokens, prices)}
       </section>
       <section class="card">
         ${cardHead("Most recurring")}
         ${recurring}
       </section>
     </div>
     <section class="card flush">
       ${cardHead("Recent incidents", `<a class="standalone" href="/incidents">All incidents →</a>`)}
       ${incidentTable(recent, empty("No incidents yet.", "The agent posts here once it has investigated its first alert.", ICON.incidents), now)}
     </section>${
       o.tokens.calls > 0
         ? `
     <section class="card flush">
       ${cardHead("Token usage by backend")}
       ${tokenTable(o.tokens, prices)}
     </section>`
         : ""
     }`,
    {
      current: "/",
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
