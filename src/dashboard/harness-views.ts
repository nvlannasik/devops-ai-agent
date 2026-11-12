import { cell, esc, fmtInt, fmtLatency, fmtPct, headers, table, timeTag } from "./html.js";
import { lineChart } from "./chart.js";
import type { GateDrill, GateStat, HarnessView } from "./queries.js";
import { ICON, badge, empty, statList, panel } from "./parts.js";
import { layout } from "./layout.js";

// --- Harness (agent/trace, migrations/011) ---

/** The three ways a nudge ends — counted against the nudge, never as fires of their own. */
const NUDGE_FATES = ["accepted", "restored", "kept-earlier"] as const;
const isFate = (o: string): boolean => (NUDGE_FATES as readonly string[]).includes(o);
/** Outcomes that mean the run went worse than planned. A refusal is the gate working and stays
 *  untoned; these are a run out of room, a dry-run the cluster rejected, a claim no tool backed. */
const BAD_OUTCOMES: Record<string, string> = { forced: "warning", exhausted: "warning", apology: "warning", failed: "warning", gap: "warning" };
/** Gates that fire when a run runs out of iterations or wall-clock time. tool-budget is left
 *  out: a conversation turn spending its small budget is the design, not a shortfall. */
const CEILINGS = ["iteration-ceiling", "deadline"];

export function harnessPage(v: HarnessView, openIncidents?: number): string {
  const byGate = new Map<string, GateStat[]>();
  for (const s of v.stats) byGate.set(s.name, [...(byGate.get(s.name) ?? []), s]);
  const fires = (ss: GateStat[], k: "d7" | "d30") => ss.filter((s) => !isFate(s.outcome)).reduce((n, s) => n + s[k], 0);
  const gates = [...byGate].sort((a, b) => fires(b[1], "d30") - fires(a[1], "d30"));
  const busiest = Math.max(1, ...gates.map(([, ss]) => fires(ss, "d30")));
  const totalFires = gates.reduce((n, [, ss]) => n + fires(ss, "d30"), 0);
  const ceilingHits = v.stats.filter((s) => CEILINGS.includes(s.name)).reduce((n, s) => n + s.d30, 0);
  const slowest = v.llm?.[0];

  const shelf = statList([
    { icon: ICON.incidents, label: "Investigations · 7d", value: fmtInt(v.runs7), sub: `${fmtInt(v.runs30)} in 30 days · incl. Slack mentions` },
    {
      icon: ICON.harness,
      label: "Gate fires · 30d",
      value: fmtInt(totalFires),
      sub: v.runs30 > 0 ? `${(totalFires / v.runs30).toFixed(1)}× per investigation` : "no investigations yet",
    },
    {
      // The tile a reader should act on: a run that hit a ceiling answered from whatever it had.
      // Counted in fires, so a run that hits both ceilings counts twice — rare, and said here.
      icon: ICON.incidents,
      label: "Hit a ceiling · 30d",
      value: fmtInt(ceilingHits),
      sub: v.runs30 > 0 ? `out of iterations or time · ${fmtInt(v.runs30)} runs` : "no investigations yet",
      tone: ceilingHits > 0 ? "warning" : undefined,
      href: "/harness/iteration-ceiling",
      hrefLabel: "Hit a ceiling: open the iteration-ceiling gate",
    },
    {
      icon: ICON.chip,
      label: "Slowest LLM · p95",
      value: slowest ? fmtLatency(slowest.p95) : "—",
      sub: slowest ? slowest.backend : "no LLM calls in 7 days",
    },
  ]);

  const rows = gates
    .map(([name, ss]) => {
      const d30 = fires(ss, "d30");
      return (
        `<tr role="row">` +
        cell("Gate", `<a href="/harness/${esc(name)}"><code translate="no">${esc(name)}</code></a>`, "primary") +
        cell("7 days", fmtInt(fires(ss, "d7")), "num") +
        // The bar is this gate against the busiest one — a ranking, so it carries no tone.
        cell(
          "30 days",
          `${fmtInt(d30)}<span class="ratio under" style="--a:${Math.round((d30 / busiest) * 100)}" aria-hidden="true"><span></span></span>`,
          "num"
        ) +
        // A ratio, not a percent: repeat-call fires several times in one investigation, and "290%"
        // read as a broken number on the first render.
        cell("Per run", v.runs30 > 0 ? `${(d30 / v.runs30).toFixed(1)}×` : "—", "num") +
        cell(
          "Outcomes (30d)",
          `<div class="roles">${ss
            .filter((s) => !isFate(s.outcome))
            .map((s) => badge(`${s.outcome} ${fmtInt(s.d30)}`, BAD_OUTCOMES[s.outcome] ?? ""))
            .join("")}</div>`
        ) +
        `</tr>`
      );
    })
    .join("");

  // One bar per gate, split by fate: what a nudge led to is a share of the whole, and three
  // numbers side by side made the reader do the division.
  const fateRows = gates
    .filter(([, ss]) => ss.some((s) => s.outcome === "nudge"))
    .map(([name, ss]) => {
      const n = (o: string) => ss.find((s) => s.outcome === o)?.d30 ?? 0;
      const total = NUDGE_FATES.reduce((t, f) => t + n(f), 0);
      const seg = (f: string) => (total > 0 ? Math.round((n(f) / total) * 100) : 0);
      return (
        `<tr role="row">` +
        cell("Gate", `<code translate="no">${esc(name)}</code>`, "primary") +
        cell("Nudges", fmtInt(n("nudge")), "num") +
        cell(
          "What it led to",
          `<span class="stack-bar" aria-hidden="true">${NUDGE_FATES.map((f) => `<span data-k="${f}" style="--w:${seg(f)}"></span>`).join("")}</span>` +
            `<span class="stack-legend">${NUDGE_FATES.map(
              (f) => `<span><i data-k="${f}"></i>${f} <span class="num">${fmtInt(n(f))}</span> · ${total > 0 ? fmtPct(n(f), total) : "—"}</span>`
            ).join("")}</span>`
        ) +
        `</tr>`
      );
    })
    .join("");

  // Slowest first: the question this answers is "which backend is the run waiting on". The bar
  // runs to this backend's p95 against the slowest p95; the darker head is its p50.
  const worst = Math.max(1, ...(v.llm ?? []).map((l) => l.p95));
  const llmRows = (v.llm ?? [])
    .map(
      (l) =>
        `<tr role="row">` +
        cell("Backend", `<code translate="no">${esc(l.backend)}</code>`, "primary") +
        cell("Calls", fmtInt(l.calls), "num") +
        cell("p50", fmtLatency(l.p50), "num") +
        cell("p95", fmtLatency(l.p95), "num") +
        cell(
          "Spread",
          `<span class="lat-bar" role="img" aria-label="p50 ${esc(fmtLatency(l.p50))}, p95 ${esc(fmtLatency(l.p95))}">` +
            `<span style="--w:${Math.round((l.p95 / worst) * 100)}"></span><span style="--w:${Math.round((l.p50 / worst) * 100)}"></span></span>`
        ) +
        `</tr>`
    )
    .join("");
  const latency = llmRows
    ? panel("LLM latency", table(headers("Backend", ["Calls", "num"], ["p50", "num"], ["p95", "num"], "Spread"), llmRows, "pairs"), '<span class="meta">7 days · per chat() call, failover included · slowest first</span>')
    : "";
  const body =
    v.stats.length === 0
      ? empty(
          "No gate events recorded yet.",
          "Every investigation since the trace recorder shipped writes them; the first alert after a deploy fills this page.",
          ICON.harness
        )
      : `${panel("Gates", table(headers("Gate", ["7 days", "num"], ["30 days", "num"], ["Per run", "num"], "Outcomes (30d)"), rows, "pairs"), '<span class="meta">most active first · production only</span>')}
         ${
           fateRows
             ? panel("What each nudge led to", `<p class="meta">A nudge buys the model one more round. <strong>accepted</strong>: its answer was used.
           <strong>restored</strong>: the round fetched nothing and the earlier answer was kept.
           <strong>kept-earlier</strong>: the round made the answer worse and was thrown away — a gate whose
           nudges mostly end here costs more than it buys.</p>
         ${table(headers("Gate", ["Nudges", "num"], "What it led to"), fateRows, "stack")}`, '<span class="meta">30 days</span>')
             : ""
         }
         ${latency}`;
  return layout(
    "Harness",
    `<div class="doc">
     <p class="eyebrow">Agent</p>
     <h1>Harness</h1>
     <p class="meta">What the code around the model decided: every nudge, refusal, cap and drop, read from the
       investigation trace. Production only.</p>
     ${shelf}
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
        cell("Outcome", badge(e.outcome, "")) +
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
     <p class="meta">${fmtInt(total)} ${total === 1 ? "fire" : "fires"} in the last 30 days, production only.</p>
     ${total > 0 ? `<div class="card">${lineChart(d.daily.map((p) => ({ label: p.day.slice(5), value: p.n })), { label: "Fires per day, last 30 days" })}</div>` : ""}
     ${panel(
       "Latest",
       rows
         ? table(headers("When", "Outcome", "Detail", "Thread"), rows, "stack")
         : empty("This gate has not fired in production yet.", "It will appear here the first time it does.", ICON.harness),
       '<span class="meta">newest first · 100 at most</span>'
     )}
     </div>`,
    { current: "/harness", openIncidents }
  );
}
