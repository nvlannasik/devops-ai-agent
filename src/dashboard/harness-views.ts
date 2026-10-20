import { cell, esc, fmtInt, fmtLatency, fmtPct, headers, table, timeTag } from "./html.js";
import { lineChart } from "./chart.js";
import type { GateDrill, GateStat, HarnessView } from "./queries.js";
import { ICON, empty, section } from "./parts.js";
import { layout } from "./layout.js";

// --- Harness (agent/trace, migrations/011) ---

/** The three ways a nudge ends — counted against the nudge, never as fires of their own. */
const NUDGE_FATES = ["accepted", "restored", "kept-earlier"] as const;
const isFate = (o: string): boolean => (NUDGE_FATES as readonly string[]).includes(o);

export function harnessPage(v: HarnessView, openIncidents?: number): string {
  const byGate = new Map<string, GateStat[]>();
  for (const s of v.stats) byGate.set(s.name, [...(byGate.get(s.name) ?? []), s]);
  const fires = (ss: GateStat[], k: "d7" | "d30") => ss.filter((s) => !isFate(s.outcome)).reduce((n, s) => n + s[k], 0);
  const rows = [...byGate]
    .sort((a, b) => fires(b[1], "d30") - fires(a[1], "d30"))
    .map(
      ([name, ss]) =>
        `<tr role="row">` +
        cell("Gate", `<a href="/harness/${esc(name)}"><code translate="no">${esc(name)}</code></a>`, "primary") +
        cell("7 days", fmtInt(fires(ss, "d7")), "num") +
        cell("30 days", fmtInt(fires(ss, "d30")), "num") +
        // A ratio, not a percent: repeat-call fires several times in one investigation, and "290%"
        // read as a broken number on the first render.
        cell("Per investigation", v.runs30 > 0 ? `${(fires(ss, "d30") / v.runs30).toFixed(1)}×` : "—", "num") +
        cell(
          "Outcomes (30d)",
          ss
            .filter((s) => !isFate(s.outcome))
            .map((s) => `${esc(s.outcome)} <span class="meta">${fmtInt(s.d30)}</span>`)
            .join(" · ")
        ) +
        `</tr>`
    )
    .join("");
  const fateRows = [...byGate]
    .filter(([, ss]) => ss.some((s) => s.outcome === "nudge"))
    .map(([name, ss]) => {
      const n = (o: string) => ss.find((s) => s.outcome === o)?.d30 ?? 0;
      const nudges = n("nudge");
      return (
        `<tr role="row">` +
        cell("Gate", `<code translate="no">${esc(name)}</code>`, "primary") +
        cell("Nudges", fmtInt(nudges), "num") +
        NUDGE_FATES.map((f) => cell(f, nudges > 0 ? `${fmtInt(n(f))} <span class="meta">${fmtPct(n(f), nudges)}</span>` : "—", "num")).join("") +
        `</tr>`
      );
    })
    .join("");
  // Slowest first: the question this answers is "which backend is the run waiting on".
  const llmRows = (v.llm ?? [])
    .map(
      (l) =>
        `<tr role="row">` +
        cell("Backend", `<code translate="no">${esc(l.backend)}</code>`, "primary") +
        cell("Calls", fmtInt(l.calls), "num") +
        cell("p50", fmtLatency(l.p50), "num") +
        cell("p95", fmtLatency(l.p95), "num") +
        `</tr>`
    )
    .join("");
  const latency = llmRows
    ? `${section(ICON.chip, "LLM latency", '<span class="meta">7 days · per chat() call, failover included · slowest first</span>')}
         ${table(headers("Backend", ["Calls", "num"], ["p50", "num"], ["p95", "num"]), llmRows, "pairs")}`
    : "";
  const body =
    v.stats.length === 0
      ? empty(
          "No gate events recorded yet.",
          "Every investigation since the trace recorder shipped writes them; the first alert after a deploy fills this page.",
          ICON.harness
        )
      : `${section(ICON.harness, "Gates", '<span class="meta">most active first · production only</span>')}
         ${table(headers("Gate", ["7 days", "num"], ["30 days", "num"], ["Per investigation", "num"], "Outcomes (30d)"), rows, "pairs")}
         ${
           fateRows
             ? `${section(ICON.overview, "What each nudge led to", '<span class="meta">30 days</span>')}
         <p class="meta">A nudge buys the model one more round. <strong>accepted</strong>: its answer was used.
           <strong>restored</strong>: the round fetched nothing and the earlier answer was kept.
           <strong>kept-earlier</strong>: the round made the answer worse and was thrown away — a gate whose
           nudges mostly end here costs more than it buys.</p>
         ${table(headers("Gate", ["Nudges", "num"], ...NUDGE_FATES.map((f) => [f, "num"] as [string, string])), fateRows, "pairs")}`
             : ""
         }
         ${latency}`;
  return layout(
    "Harness",
    `<div class="doc">
     <p class="eyebrow">Agent</p>
     <h1>Harness</h1>
     <p class="meta">What the code around the model decided: every nudge, refusal, cap and drop, read from the
       investigation trace. ${fmtInt(v.runs7)} investigations in the last 7 days, ${fmtInt(v.runs30)} in 30.</p>
     ${body}
     </div>`,
    { current: "/harness", openIncidents }
  );
}

export function harnessGatePage(name: string, d: GateDrill, now: Date, openIncidents?: number): string {
  const rows = d.events
    .map(
      (e) =>
        `<tr role="row">` +
        cell("When", timeTag(e.createdAt, now), "when") +
        cell("Outcome", `<code translate="no">${esc(e.outcome)}</code>`) +
        cell("Detail", e.detail ? esc(e.detail) : `<span class="meta">—</span>`) +
        cell(
          "Thread",
          e.incidentId !== null
            ? `<a href="/incidents/${e.incidentId}">Incident ${e.incidentId}</a>`
            : `<span class="meta" translate="no">${esc(e.threadTs)}</span>`
        ) +
        `</tr>`
    )
    .join("");
  const total = d.daily.reduce((n, p) => n + p.n, 0);
  return layout(
    name,
    `<div class="doc">
     <p class="eyebrow"><a href="/harness">Harness</a></p>
     <h1><code translate="no">${esc(name)}</code></h1>
     <p class="meta">${fmtInt(total)} time(s) in the last 30 days, production only.</p>
     ${total > 0 ? lineChart(d.daily.map((p) => ({ label: p.day.slice(5), value: p.n })), { label: "Fires per day, last 30 days" }) : ""}
     ${section(ICON.incidents, "Latest", '<span class="meta">newest first · 100 at most</span>')}
     ${
       rows
         ? table(headers("When", "Outcome", "Detail", "Thread"), rows, "stack")
         : empty("This gate has not fired in production yet.", "It will appear here the first time it does.", ICON.harness)
     }
     </div>`,
    { current: "/harness", openIncidents }
  );
}
