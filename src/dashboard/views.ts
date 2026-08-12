import { cell, esc, fmtDate, fmtInt, fmtPct, headers, table } from "./html.js";
import { renderRca } from "./rca.js";
import { barChart } from "./chart.js";
import { topologyDiagram } from "./topology-svg.js";
import { TOPO_SCRIPT } from "./topology-script.js";
import { STYLES } from "./styles.js";
import { PAGE_SIZE } from "./filters.js";
import type { Filters } from "./filters.js";
import type {
  FeedbackRow, IncidentDetail, IncidentPage, IncidentRow, Overview, RemediationRow, Tokens,
} from "./queries.js";
import { SESSION_TTL_MS } from "./auth.js";
import { rowId } from "./topology.js";
import type { BackendNode, Capability, Node as TopoNode, Topology } from "./topology.js";

// Each glyph is drawn from the page it opens rather than picked off a generic set: a bar
// series for the weekly chart the overview leads with, an alert triangle for a table whose
// every row is one, three linked nodes for the dependency map. Inline because the CSP sends
// `default-src 'none'` — an icon font or a sprite sheet is a fetch this page cannot make.
// Stroked, not filled: at 18px a solid glyph reads as a blob.
//
// aria-hidden on every one of them. The icon is not the name of the destination; the text
// beside it is, and that text stays in the markup even at the narrow breakpoint where CSS
// clips it out of sight. That is what lets the rail go icon-only without going unlabelled.
const ico = (paths: string): string =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"` +
  ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICON = {
  overview: ico(`<path d="M3 21h18"/><path d="M7 21v-7"/><path d="M12 21V4"/><path d="M17 21v-11"/>`),
  incidents: ico(
    `<path d="M10.3 4 2.4 18a1.9 1.9 0 0 0 1.7 2.9h15.8a1.9 1.9 0 0 0 1.7-2.9L13.7 4a1.9 1.9 0 0 0-3.4 0Z"/>` +
      `<path d="M12 9.5v4"/><path d="M12 17.2h.01"/>`
  ),
  topology: ico(
    `<circle cx="12" cy="5" r="2.6"/><circle cx="5" cy="19" r="2.6"/><circle cx="19" cy="19" r="2.6"/>` +
      `<path d="M10.4 7.3 6.6 16.4"/><path d="M13.6 7.3l3.8 9.1"/>`
  ),
  signout: ico(`<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="m10 16 4-4-4-4"/><path d="M14 12H4"/>`),

  // Section and figure glyphs. Same rule as the rail's: each one is drawn from what it labels,
  // and a glyph that would serve two different meanings is redrawn rather than reused. The
  // pairs that DO repeat are deliberate — the wrench is remediation wherever remediation is
  // named, the speech bubble is on-call, the chip is the model — because a reader who learns
  // one on the overview should not have to relearn it on the incident page.
  chip: ico(
    `<rect x="7" y="7" width="10" height="10" rx="1.7"/>` +
      `<path d="M10 3.2v3.4"/><path d="M14 3.2v3.4"/><path d="M10 17.4v3.4"/><path d="M14 17.4v3.4"/>` +
      `<path d="M3.2 10h3.4"/><path d="M3.2 14h3.4"/><path d="M17.4 10h3.4"/><path d="M17.4 14h3.4"/>`
  ),
  repeat: ico(
    `<path d="m17 2.6 3.4 3.4L17 9.4"/><path d="M3.6 11.4V10a4 4 0 0 1 4-4h12.8"/>` +
      `<path d="M7 21.4 3.6 18 7 14.6"/><path d="M20.4 12.6V14a4 4 0 0 1-4 4H3.6"/>`
  ),
  search: ico(`<circle cx="10.5" cy="10.5" r="7"/><path d="m20.5 20.5-5.1-5.1"/>`),
  wrench: ico(
    `<path d="M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9l-6.8 6.8a2.1 2.1 0 0 1-3-3l6.8-6.8a6 6 0 0 1 7.9-7.9Z"/>`
  ),
  speech: ico(`<path d="M20.5 14.5a2 2 0 0 1-2 2H7.8L3.5 20.8V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/>`),
  check: ico(`<circle cx="12" cy="12" r="8.8"/><path d="m8.2 12.3 2.6 2.6 5-5.6"/>`),
  layers: ico(`<path d="m12 2.6 9 4.9-9 4.9-9-4.9 9-4.9Z"/><path d="m3 13 9 4.9 9-4.9"/>`),
  // The two arrows are a pair and are read as one: what went to the model, what came back.
  // Same baseline, same head, mirrored — anything else and the reader has to check each.
  inTokens: ico(`<path d="M12 3.4v11"/><path d="m7.6 10 4.4 4.4 4.4-4.4"/><path d="M4 20.2h16"/>`),
  outTokens: ico(`<path d="M12 20.6v-11"/><path d="m7.6 14 4.4-4.4 4.4 4.4"/><path d="M4 3.8h16"/>`),
  bolt: ico(`<path d="M13.2 2.4 4.4 13.6h7.1l-1 8 8.8-11.2h-7.1l1-8Z"/>`),
  inbound: ico(`<path d="M20.6 12H8.2"/><path d="m12.6 7.2 5 4.8-5 4.8"/><path d="M3.6 4.2v15.6"/>`),
  outbound: ico(`<path d="M3.4 12h12.4"/><path d="m11.4 7.2 5 4.8-5 4.8"/><path d="M20.4 4.2v15.6"/>`),
  plug: ico(
    `<path d="M12 21.6v-4.2"/><path d="M8.8 6.6V2.4"/><path d="M15.2 6.6V2.4"/>` +
      `<path d="M5.8 12.4V6.6h12.4v5.8a5 5 0 0 1-5 5h-2.4a5 5 0 0 1-5-5Z"/>`
  ),
};

const NAV = [
  { href: "/", label: "Overview", icon: ICON.overview },
  { href: "/incidents", label: "Incidents", icon: ICON.incidents },
  { href: "/topology", label: "Topology", icon: ICON.topology },
];

// The two theme-color values are the only colours written outside styles.ts, and they are
// literals because a <meta> attribute cannot read a custom property. They are --bg for each
// scheme; change one and change the other, or the phone's browser chrome stops matching the
// page it sits above.
//
// `chrome: "bare"` is for the pages you can reach without a session — the sign-in form and
// the "not configured" notice. Navigation there is a row of links that all bounce straight
// back to where you already are, and a Sign out button for a session you do not have. So the
// rail is not rendered at all rather than rendered empty: a bare column of chrome down the
// side of a one-field form is a frame around nothing.
export function layout(title: string, body: string, current = "", chrome: "full" | "bare" = "full"): string {
  const nav = NAV.map(
    (n) => `<a href="${n.href}"${n.href === current ? ` aria-current="page"` : ""}>` +
      `${n.icon}<span class="lbl">${n.label}</span></a>`
  ).join("");
  const rail =
    chrome === "full"
      ? `<header class="rail">` +
        `<span class="brand" translate="no">devops-ai-agent</span>` +
        `<nav aria-label="Primary">${nav}</nav>` +
        `<form class="signout" method="post" action="/logout">` +
        `<button type="submit">${ICON.signout}<span class="lbl">Sign out</span></button></form>` +
        `</header>`
      : "";
  const note =
    chrome === "full"
      ? `Read-only. This session ends after ${SESSION_HOURS} hours.`
      : `Read-only incident dashboard.`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f4f6f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
<title>${esc(title)} — DevOps AI Agent</title>
<style>${STYLES}</style>
</head><body${chrome === "bare" ? ` class="bare"` : ""}>
<a class="skip" href="#main">Skip to content</a>
${rail}
<div class="pane">
<main id="main">${body}</main>
<footer class="bottom">${note} The password is one lock; not routing this port from the Ingress is the other. Keep both.</footer>
</div>
</body></html>`;
}

const SESSION_HOURS = Math.round(SESSION_TTL_MS / 3_600_000);

/**
 * The sign-in form. `error` is shown verbatim to the person typing, so it says what to do
 * next and nothing about which half was wrong — "no such user" and "wrong password" are the
 * same sentence here, and with one shared password there is not even a user to name.
 */
export function loginPage(opts: { error?: string; next?: string } = {}): string {
  const body =
    `<section class="signin">` +
    `<h1>Sign in</h1>` +
    `<p class="signin-lede">Incident history and the agent's live dependency map. ` +
    `Enter the shared dashboard password to continue.</p>` +
    (opts.error ? `<p class="formerror" role="alert">${esc(opts.error)}</p>` : "") +
    `<form method="post" action="/login" class="signin-form">` +
    (opts.next && opts.next !== "/" ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : "") +
    `<label for="password">Dashboard password</label>` +
    // autocomplete="current-password" is what makes a password manager offer to fill this;
    // without it browsers guess, and a form with one field is exactly where they guess wrong.
    `<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>` +
    `<button type="submit">Sign in</button>` +
    `</form>` +
    `</section>`;
  return layout("Sign in", body, "", "bare");
}

// `translate="no"` travels with the mono/code role throughout this file. Those cells hold
// namespaces, queue names, model ids and endpoints — values that have to match what you type
// into kubectl. A browser offering to translate the page must not turn `prod` into `produksi`.
// The prose (the RCA, the empty states, the labels) is left translatable on purpose.

// An allowlist, not a pass-through: the value lands in a data-* attribute that selects a
// colour, and severity/status text arrives from Alertmanager and the database. Anything
// unrecognised renders in the neutral tone rather than inventing a class name from input.
const TONE: Record<string, string> = {
  critical: "critical", warning: "warning", info: "info",
  resolved: "ok", succeeded: "ok", confirmed: "ok", approved: "ok",
  failed: "critical", rejected: "critical",
  executing: "warning", proposed: "info",
};
const tone = (s: unknown): string => TONE[String(s ?? "").toLowerCase()] ?? "";

const toneAttr = (s: unknown): string => {
  const t = tone(s);
  return t ? ` data-tone="${esc(t)}"` : "";
};

const badge = (label: string, t: string = tone(label)): string =>
  `<span class="badge"${t ? ` data-tone="${esc(t)}"` : ""}>${esc(label)}</span>`;

const dash = `<span class="meta">—</span>`;
const severityBadge = (s: string | null): string => (s ? badge(s) : dash);

// Alert names are one long CamelCase identifier with no space in them, so in a narrow column the
// browser has nowhere to break and falls back to breaking anywhere — PersistentVolumeFillin/gUp.
// <wbr> offers the humps as break opportunities, and a browser takes an offered break before it
// invents one, so the name comes apart at PersistentVolume/FillingUp instead.
//
// Escape first, insert markup second — the same invariant rca.ts is built on. The regex is safe
// against the escaped string on purpose: every entity esc() can emit (&amp; &lt; &gt; &quot;
// &#39;) is lowercase or digits after the ampersand, so a lower-to-upper boundary can never fall
// inside one and split it.
const breakable = (name: string): string => esc(name).replace(/([a-z0-9])(?=[A-Z])/g, "$1<wbr>");

// Every empty state names the fact and then the next move. An empty screen that only says
// "no data" leaves the reader unsure whether the system is broken or simply quiet.
const empty = (headline: string, next: string): string =>
  `<p class="empty"><strong>${esc(headline)}</strong>${esc(next)}</p>`;

// A section heading with a glyph. The icon and the label are one flex item so h2's own gap —
// which is sized for the distance out to the hairline — never lands between a picture and the
// word it labels; a trailing link keeps working, it sorts past the hairline as before.
const section = (icon: string, title: string, trailing = ""): string =>
  `<h2><span class="sec">${icon}${esc(title)}</span>${trailing}</h2>`;

// The icon is markup, not text, so it is passed pre-built by the caller rather than escaped
// here — every value that came from a row or from the LLM still goes through esc().
interface Stat {
  label: string;
  value: string;
  sub?: string;
  icon?: string;
  // The same severity vocabulary the tables use, for the one figure on a shelf that can be bad
  // news. Only set it when the number IS the bad news — a tone on every tile is a tone on none.
  // Passed through toneAttr like every other tone on the page, so it meets the same allowlist.
  tone?: string;
}
// Four to a shelf, always. The grid is a fixed 4 → 2 → 1 ladder, so a fifth figure does not wrap
// into a row of its own — it either earns a place among the four or it belongs in a sub-line.
//
// `facts` marks a shelf that carries an incident's identity rather than a measurement — a
// namespace, a confidence, two timestamps. Same shelf, but on a phone each tile lays its label
// and value on one line instead of stacking them: four figures deserve the height, four labels
// do not, and this one sits above the analysis a reader came for.
const statList = (items: Stat[], variant: "" | "facts" = ""): string =>
  `<dl class="stats${variant ? ` ${variant}` : ""}">` +
  items
    .map(
      (s) => `<div class="stat"${toneAttr(s.tone)}>` +
        `<dt>${s.icon ?? ""}${esc(s.label)}</dt><dd>${esc(s.value)}` +
        (s.sub ? `<span>${esc(s.sub)}</span>` : "") + `</dd></div>`
    )
    .join("") +
  `</dl>`;

// Every cell carries a class, including the two that hold nothing but a badge. Below 46rem the
// stylesheet stops laying this out as a table and lays each row out as a card instead, and it
// addresses the cells by name to do it — a positional selector would silently re-target the day
// someone inserts a column, which is the kind of break no test written against the columns as a
// SET would catch.
function incidentTable(rows: IncidentRow[], whenEmpty: string): string {
  if (rows.length === 0) return whenEmpty;
  const body = rows
    .map(
      (r) => `<tr role="row"${toneAttr(r.severity)}>
      <td role="cell" class="when">${esc(fmtDate(r.created_at))}</td>
      <td role="cell" class="primary"><a href="/incidents/${esc(r.id)}">${breakable(r.alertname)}</a>${
        r.root_cause ? `<div class="sub">${esc(r.root_cause)}</div>` : ""
      }</td>
      <td role="cell" class="ns mono" translate="no">${esc(r.namespace ?? "—")}</td>
      <td role="cell" class="sev">${severityBadge(r.severity)}</td>
      <td role="cell" class="state">${r.resolved_at ? badge("resolved", "ok") : badge("firing", "")}</td>
    </tr>`
    )
    .join("");
  return table(headers("When", "Alert", "Namespace", "Severity", "State"), body, "cards");
}

// What the investigations cost. The stats are totals over the window; the table is per
// backend AND model, because under the router "which model did that" is the question — a
// heavy backend answering what a light one could have is the finding this section exists for.
function tokenUsage(t: Tokens): string {
  if (t.calls === 0) {
    return empty(
      "No LLM calls recorded in this window.",
      "Accounting starts with the next investigation the agent runs."
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
        `</tr>`
    )
    .join("");
  return (
    statList(
      [
        // The call count rides in the sub-line rather than taking a fifth tile: it is the
        // denominator of the figure above it ("how much, over how many calls"), and as its own
        // tile it was the odd one out on a four-wide shelf — a count of events among three
        // counts of tokens.
        { icon: ICON.layers, label: "Total tokens", value: fmtInt(t.input + t.output), sub: `input + output over ${fmtInt(t.calls)} calls` },
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
      headers("Backend", "Model", "Calls", "Input", "Output", "Cache read"),
      rows,
      "pairs"
    )
  );
}

export function overviewPage(o: Overview, recent: IncidentRow[]): string {
  const remediationTotal = o.remediationSucceeded + o.remediationFailed;
  const feedbackTotal = Object.values(o.feedback).reduce((a, b) => a + b, 0);

  const recurring =
    o.recurring.length === 0
      ? empty("Nothing has recurred.", "Every alert in the last 30 days fired exactly once.")
      : table(
          headers("Alert", "Namespace", "Times", "Last seen"),
          o.recurring
            .map(
              (r) => `<tr role="row">` +
                // The same wrap points the incident list offers: this column holds the longest
                // string on the page and is the one the other three are read against.
                cell("Alert", breakable(r.alertname), "primary") +
                cell("Namespace", `<span translate="no">${esc(r.namespace ?? "—")}</span>`, "mono") +
                cell("Times", fmtInt(r.n), "num") +
                cell("Last seen", esc(fmtDate(r.last_seen)), "when") +
                `</tr>`
            )
            .join(""),
          "pairs"
        );

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
  return layout(
    "Overview",
    `<h1 class="eyebrow">Incidents · last 30 days</h1>
     ${statList(
       [
         { icon: ICON.incidents, label: "Open", value: fmtInt(open), sub: `of ${fmtInt(o.totalIncidents)} investigated`, tone: open > 0 ? "critical" : undefined },
         { icon: ICON.check, label: "Resolved", value: fmtPct(o.resolvedIncidents, o.totalIncidents), sub: `${o.resolvedIncidents} of ${o.totalIncidents}` },
         { icon: ICON.wrench, label: "Remediation applied", value: fmtPct(o.remediationSucceeded, remediationTotal), sub: `${o.remediationSucceeded} of ${remediationTotal}` },
         { icon: ICON.speech, label: "On-call replies", value: fmtInt(feedbackTotal), sub: `${fmtInt(o.feedback.resolved ?? 0)} confirmed fixed` },
       ]
     )}
     <section class="hero">
       <div class="hero-body">
         <p class="hero-figure">
           <span class="hero-value">${esc(fmtInt(o.totalIncidents))}</span>
           <span class="hero-unit">investigated</span>
         </p>
         <div class="hero-chart">${barChart(o.weekly, { label: "incidents per week" })}</div>
       </div>
     </section>
     ${section(ICON.chip, "Token usage")}
     ${tokenUsage(o.tokens)}
     ${section(ICON.repeat, "Most recurring")}
     ${recurring}
     ${section(ICON.incidents, "Recent incidents", `<a href="/incidents">All incidents →</a>`)}
     ${incidentTable(recent, empty("No incidents yet.", "The agent posts here once it has investigated its first alert."))}`,
    "/"
  );
}

// How many pages sit either side of the current one before the run is elided.
const PAGE_SPAN = 2;

/**
 * The page numbers to offer: `1 … 4 5 [6] 7 8 … 26`. The first and last are always in the
 * list, so both ends of the range stay one click away from anywhere in the middle.
 *
 * A run is only elided when eliding it saves a step. Exactly one hidden page renders as that
 * page rather than as an ellipsis standing in for a single number — `1 … 3 4 5` costs the
 * same width as `1 2 3 4 5` and hides a destination for nothing. `null` is the gap.
 */
export function pageWindow(current: number, last: number): (number | null)[] {
  const want = new Set<number>([1, last]);
  for (let p = current - PAGE_SPAN; p <= current + PAGE_SPAN; p++) {
    if (p >= 1 && p <= last) want.add(p);
  }
  const out: (number | null)[] = [];
  for (const p of [...want].sort((a, b) => a - b)) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (typeof prev === "number" && p - prev > 1) out.push(p - prev === 2 ? p - 1 : null);
    out.push(p);
  }
  return out;
}

/**
 * Where you are in the range, and every way out of it.
 *
 * The summary is rendered whenever there are rows, even on a single page — "3 incidents" is
 * an answer, and a reader who filtered to nothing wants the count more than the controls.
 * The controls appear only when there is somewhere to go.
 */
function pager(p: IncidentPage, f: Filters, qs: (page: number) => string): string {
  if (p.rows.length === 0) return "";
  const first = (f.page - 1) * PAGE_SIZE + 1;
  const shown = first + p.rows.length - 1;
  // The count is bounded (COUNT_CAP), so past the ceiling it is a floor and says so. "5,000+"
  // is true; a hard 5,000 under a table that keeps producing next pages is not.
  const total = `${fmtInt(p.total)}${p.capped ? "+" : ""}`;
  const summary =
    `<p class="pager-count">Showing <b>${esc(fmtInt(first))}–${esc(fmtInt(shown))}</b> of ` +
    `<b>${esc(total)}</b> incident${p.total === 1 ? "" : "s"}</p>`;

  const last = Math.max(1, Math.ceil(p.total / PAGE_SIZE), f.page);
  if (last === 1 && !p.hasMore) return `<nav class="pager" aria-label="Pagination">${summary}</nav>`;

  // A step that leads nowhere keeps its slot but stops being a control: no href, and hidden
  // from assistive tech rather than announced as a link that does not go anywhere. Holding
  // the position matters — the arrows are what a reader clicks repeatedly, and a Next that
  // slides sideways as the row count changes is a target that moves under the pointer.
  const step = (to: number, live: boolean, glyph: string, label: string, rel: string): string =>
    live
      ? `<li><a class="step" href="${esc(qs(to))}" rel="${rel}" aria-label="${label}">${glyph}</a></li>`
      : `<li><span class="step off" aria-hidden="true">${glyph}</span></li>`;

  const numbers = pageWindow(f.page, last)
    .map((n) =>
      n === null
        ? `<li><span class="gap" aria-hidden="true">…</span></li>`
        : n === f.page
          ? `<li><span class="cur" aria-current="page">${esc(n)}</span></li>`
          : `<li><a href="${esc(qs(n))}" aria-label="Page ${esc(n)}">${esc(n)}</a></li>`
    )
    .join("");

  return (
    `<nav class="pager" aria-label="Pagination">${summary}<ul class="pages">` +
    step(f.page - 1, f.page > 1, "←", "Previous page", "prev") +
    numbers +
    // hasMore comes from the over-fetch, not from the count — so the last page is right even
    // when the count has hit its ceiling and cannot say how many pages there really are.
    step(f.page + 1, p.hasMore, "→", "Next page", "next") +
    `</ul></nav>`
  );
}

export function listPage(p: IncidentPage, f: Filters): string {
  const qs = (page: number): string => {
    const q = new URLSearchParams();
    if (f.from) q.set("from", f.from.toISOString().slice(0, 10));
    if (f.to) q.set("to", f.to.toISOString().slice(0, 10));
    if (f.alertname) q.set("alertname", f.alertname);
    if (f.namespace) q.set("namespace", f.namespace);
    if (f.severity) q.set("severity", f.severity);
    if (f.resolved !== null) q.set("resolved", String(f.resolved));
    // page=1 is omitted: a link that restates the default is a query string the reader has to
    // read past to see which filters are actually on.
    if (page > 1) q.set("page", String(page));
    const s = q.toString();
    return s ? `/incidents?${s}` : "/incidents";
  };

  const sel = (v: string, cur: string | null, label: string): string =>
    `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;

  const filtered = !!(f.from || f.to || f.alertname || f.namespace || f.severity || f.resolved !== null);

  // Two different absences. No rows on page 1 means the filters matched nothing; no rows on
  // page 7 means the range ended earlier than the URL claims — usually a bookmark outliving
  // the rows it pointed at — and the way out of that is a link, not a suggestion to filter.
  const nothing =
    f.page > 1
      ? `<p class="empty"><strong>Nothing on page ${esc(f.page)}.</strong>` +
        `This filter matches ${esc(fmtInt(p.total))} incident${p.total === 1 ? "" : "s"}. ` +
        `<a href="${esc(qs(1))}">Go to the first page</a>.</p>`
      : empty("No incidents match these filters.", "Widen the date range, or clear a filter to see more.");

  // The two free-text fields take identifiers, not words: autocomplete off (the browser has
  // no saved value that belongs in "Namespace"), autocapitalize off (a phone would send
  // `Prod`, which matches nothing), spellcheck off (every alert name is a red squiggle).
  return layout(
    "Incidents",
    `<h1>Incidents</h1>
     <form class="filters" method="get" action="/incidents">
       <label>From<input type="date" name="from" value="${esc(f.from ? f.from.toISOString().slice(0, 10) : "")}"></label>
       <label>To<input type="date" name="to" value="${esc(f.to ? f.to.toISOString().slice(0, 10) : "")}"></label>
       <label>Alert<input type="text" name="alertname" value="${esc(f.alertname)}" placeholder="KubePodCrashLooping"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <label>Namespace<input type="text" name="namespace" value="${esc(f.namespace)}" placeholder="prod"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <label>Severity<select name="severity">
         ${sel("", f.severity ?? "", "any")}${sel("critical", f.severity ?? "", "critical")}${sel("warning", f.severity ?? "", "warning")}${sel("info", f.severity ?? "", "info")}
       </select></label>
       <label>State<select name="resolved">
         ${sel("", f.resolved === null ? "" : String(f.resolved), "any")}
         ${sel("true", f.resolved === null ? "" : String(f.resolved), "resolved")}
         ${sel("false", f.resolved === null ? "" : String(f.resolved), "firing")}
       </select></label>
       <div class="actions">
         <button type="submit">Apply filters</button>
         ${filtered ? `<a href="/incidents">Clear</a>` : ""}
       </div>
     </form>
     ${incidentTable(p.rows, nothing)}
     ${pager(p, f, qs)}`,
    "/incidents"
  );
}

export function detailPage(d: {
  incident: IncidentDetail;
  remediations: RemediationRow[];
  feedback: FeedbackRow[];
}): string {
  const i = d.incident;
  // app_redirect needs no workspace domain, so the deep link costs no configuration.
  // encodeURIComponent() first (safe *inside* the URL — a stray & or # in a component
  // can't inject a second query param or a fragment), then esc() on the whole string
  // (safe *inside* the href attribute). Both layers are required; neither is redundant.
  const slack =
    i.channel && i.thread_ts
      ? `<a class="standalone" href="${esc(`https://slack.com/app_redirect?channel=${encodeURIComponent(i.channel)}&message_ts=${encodeURIComponent(i.thread_ts)}`)}">Open the Slack thread →</a>`
      : "";

  // Both of these are records of five fields, not lists to scan, so below 40rem they stack into
  // captioned pairs rather than scrolling sideways — five columns on a phone put Result and
  // Executed past the right edge, which on a remediation table means the outcome of the change
  // is the part you cannot see. headers() keeps the <th> text and the cell captions the same
  // string: they are the same label, and a table whose captions have drifted from its headers
  // is one nobody notices is wrong.
  const remediations =
    d.remediations.length === 0
      ? empty("No remediation proposed.", "The agent investigated this alert but suggested no change.")
      : table(
          headers("Action", "Status", "Approved by", "Result", "Executed"),
          d.remediations
            .map(
              (r) => `<tr role="row"${toneAttr(r.status)}>` +
                cell("Action", `<span translate="no">${esc(r.action)}</span><div class="sub" translate="no">${esc(JSON.stringify(r.params))}</div>`, "mono") +
                cell("Status", badge(r.status)) +
                cell("Approved by", esc(r.approved_by ?? "—")) +
                cell("Result", esc(r.result ?? "—")) +
                cell("Executed", esc(fmtDate(r.executed_at)), "when") +
                `</tr>`
            )
            .join(""),
          "stack"
        );

  const feedback =
    d.feedback.length === 0
      ? empty("No on-call feedback yet.", "Reply in the Slack thread to record what actually fixed it.")
      : table(
          headers("From", "Confirmed root cause", "Action taken", "Outcome", "When"),
          d.feedback
            .map(
              (r) => `<tr role="row"${toneAttr(r.outcome)}>` +
                cell("From", esc(r.slack_user ?? "—")) +
                cell("Confirmed root cause", esc(r.confirmed_root_cause ?? "—")) +
                cell("Action taken", esc(r.action_taken ?? "—")) +
                cell("Outcome", r.outcome ? badge(r.outcome) : dash) +
                cell("When", esc(fmtDate(r.created_at)), "when") +
                `</tr>`
            )
            .join(""),
          "stack"
        );

  return layout(
    i.alertname,
    // The id is a real identifier, so it earns the caption slot above the title. The sections
    // below it are not numbered: they are facts about one incident, not a sequence.
    `<p class="eyebrow">Incident #${esc(i.id)}</p>
     <h1>${esc(i.alertname)}</h1>
     <div class="title-meta">
       ${severityBadge(i.severity)}
       ${i.resolved_at ? badge("resolved", "ok") : badge("firing", "")}
       ${slack}
     </div>
     ${statList(
       [
         { label: "Namespace", value: i.namespace ?? "—" },
         { label: "Confidence", value: i.confidence ?? "—" },
         { label: "Fired", value: fmtDate(i.created_at) },
         { label: "Resolved", value: fmtDate(i.resolved_at) },
       ],
       "facts"
     )}
     ${section(ICON.search, "Root cause analysis")}
     ${
       i.rca && i.rca.trim()
         ? renderRca(i.rca)
         : empty("No analysis recorded.", "The investigation ended before it produced one — the Slack thread has the run.")
     }
     ${section(ICON.wrench, "Remediation")}
     ${remediations}
     ${section(ICON.speech, "On-call feedback")}
     ${feedback}`,
    "/incidents"
  );
}

export function errorPage(title: string, message: string, chrome: "full" | "bare" = "full"): string {
  return layout(title, `<h1>${esc(title)}</h1>${empty(title, message)}`, "", chrome);
}

// `group` is only ever the anchor prefix: each box in the diagram links to its own row here,
// and rowId() is the single definition both sides derive that id from. Optional because the
// activeClient table reuses this helper for a row the diagram never draws (non-router
// providers have no backend chips), and an anchor nothing can link to is just dead markup.
const nodeRows = (nodes: TopoNode[], group?: "in" | "out"): string =>
  nodes.length === 0
    ? empty("Nothing configured in this group.", "Set the matching environment variables to wire one up.")
    : table(
        headers("Dependency", "Endpoint", "Notes"),
        nodes
          .map(
            (n, i) => `<tr role="row"${group ? ` id="${rowId(group, i)}"` : ""}${n.configured ? "" : ` data-tone="warning"`}>` +
              cell("Dependency", esc(n.label), "primary") +
              cell("Endpoint", `<span translate="no">${esc(n.detail)}</span>`, "mono") +
              cell(
                "Notes",
                `${esc(n.meta)}${n.configured ? "" : ` ${badge("not configured", "warning")}`}`,
                "meta"
              ) +
              `</tr>`
          )
          .join(""),
        // Stacked, not paired: every one of these three is a phrase rather than a value —
        // "Postgres (incident memory)", a queue pair with an arrow between them, "bot token
        // present, socket mode present". A caption beside them would leave each phrase a third
        // of the screen to wrap in.
        "stack"
      );

// Paired rather than stacked: a backend row is a spec sheet — a name, two identifiers, an enum
// and an endpoint. Only the endpoint is long, and it is the one field a reader scans down rather
// than reads, so it keeps the column the other four set.
const backendRows = (backends: BackendNode[]): string =>
  table(
    headers("Backend", "Kind", "Model", "Route", "Reached via"),
    backends
      .map(
        (b, i) => `<tr role="row" id="${rowId("backend", i)}">` +
          cell("Backend", esc(b.name), "primary") +
          cell("Kind", `<span translate="no">${esc(b.kind)}</span>`, "mono") +
          cell("Model", `<span translate="no">${esc(b.model)}</span>`, "mono") +
          cell("Route", badge(b.route, "")) +
          cell("Reached via", `<span translate="no">${esc(b.endpoint)}</span>`, "mono") +
          `</tr>`
      )
      .join(""),
    "pairs"
  );

// The one table on this page whose source is NOT config: these families are derived from the
// tool list devops-mcp-server returned when the agent connected. So the empty state is a real
// state, not a misconfiguration — the agent may simply not have connected yet — and it must not
// read like the "set the environment variable" copy the config tables use.
// A family can hold thirty tools, and thirty names per row would bury the four numbers that
// answer "what can this agent see". <details> gives the family line as the glance and the
// names on demand — native, keyboard-operable, and the only disclosure widget that works
// under a `default-src 'none'` CSP, which forbids the script every other one needs.
const capabilityRows = (caps: Capability[]): string =>
  caps.length === 0
    ? empty(
        "No tools discovered yet.",
        "The agent lists them when it connects to devops-mcp-server. If this persists, the server is unreachable."
      )
    // The one table on this page that stays a table at every width, and deliberately. Two
    // columns — a family name and a count — fit 320px with room to spare, so there is nothing to
    // rescue; and stacking it would put the expanded tool list BETWEEN the family and its count,
    // which is the pair the row exists to show. A narrow layout is for columns that fall off the
    // edge, not for every table.
    : table(
        `<th>Family</th><th>Tools</th>`,
        caps
          .map(
            (c, i) => `<tr id="${rowId("cap", i)}"><td class="primary">` +
              // The name is wrapped rather than styled on the <summary> itself: the disclosure
              // triangle lives inside that box, and every property that would set it off from
              // the name (padding, indent) moves the triangle with it. A span is the one thing
              // the marker cannot follow.
              `<details><summary><span class="mono" translate="no">${esc(c.name)}</span></summary>` +
              `<ul class="toollist">${c.tools
                .map(
                  (t) => `<li class="mono" translate="no">${esc(t.name)}` +
                    // The most consequential fact on this page: which of these can change the
                    // cluster. It is marked, not filtered — a reader who sees no marks has
                    // been told something, and a reader who sees one knows to look.
                    `${t.write ? ` ${badge("write", "warning")}` : ""}</li>`
                )
                .join("")}</ul></details></td>` +
              `<td class="num">${fmtInt(c.tools.length)}</td></tr>`
          )
          .join("")
      );

// Scale, with no script: three radios whose :checked state drives the SVG's width, inside a
// container that scrolls. This is the floor, not the ceiling — topology-script.ts removes
// these radios and takes over with continuous drag-pan and zoom. It stays because the floor
// has to hold on its own: scripting off, or the nonce'd <script> blocked, and the diagram is
// still readable, still scalable, and every box still links to its row.
//
// aria-label duplicates the visible text with "Zoom" in front. The visible string stays a
// substring of the accessible name (WCAG 2.5.3), so voice control still works on what a
// sighted user can read, while a screen-reader user hears what the control is for.
const ZOOM = [
  { id: "topo-z1", text: "Fit", label: "Zoom to fit" },
  { id: "topo-z2", text: "160%", label: "Zoom 160%" },
  { id: "topo-z3", text: "240%", label: "Zoom 240%" },
];

// The interactive controls, rendered server-side but hidden until the script sets data-live.
// Server-side so the strings and their labelling live here with the rest of the page's copy
// rather than inside a JavaScript string; hidden because a button whose entire behaviour is a
// listener is a dead control for anyone whose browser never ran the listener.
//
// The glyphs are U+2212 and U+002B — read as "minus" and "plus" by neither, which is what the
// aria-labels are for. The readout is not aria-live: it changes on every wheel notch, and a
// screen reader announcing "142%, 156%, 171%" over a drag is noise, not information.
const TOOLS =
  `<div class="topo-tools">` +
  `<p class="topo-hint">Drag to pan · Ctrl + scroll to zoom</p>` +
  `<button type="button" data-zoom="out" aria-label="Zoom out">−</button>` +
  `<span class="topo-level" translate="no">100%</span>` +
  `<button type="button" data-zoom="in" aria-label="Zoom in">+</button>` +
  `<button type="button" data-zoom="reset">Reset</button>` +
  `</div>`;

// The radios are siblings of, and precede, .topo-view because that is what the :checked ~
// selector needs — wrapping them in a fieldset would read better and would break the only
// mechanism that makes this work without script.
//
// The <script> sits immediately after the frame rather than at the end of the document: it
// runs the moment the frame is parsed, so the script-free bar is swapped for the live toolbar
// before the browser has painted either, instead of flashing one and then the other.
const zoom = (svg: string, nonce: string): string =>
  `<div class="card flush topo-frame">` +
  ZOOM.map(
    (z, i) => `<input type="radio" name="topo-zoom" id="${z.id}" class="topo-z"` +
      `${i === 0 ? " checked" : ""} aria-label="${z.label}">`
  ).join("") +
  `<div class="topo-bar">${ZOOM.map((z) => `<label for="${z.id}">${z.text}</label>`).join("")}</div>` +
  TOOLS +
  `<div class="topo-view">${svg}</div>` +
  `</div>` +
  `<script nonce="${esc(nonce)}">${TOPO_SCRIPT}</script>`;

/**
 * `nonce` is required, not optional: it is what the response's own
 * `script-src 'nonce-…'` names, and a page built without one would render a <script> that
 * every browser then refuses to run — an interactive map that silently is not one. The only
 * caller mints it per response (see csp() in server.ts).
 */
export function topologyPage(t: Topology, nonce: string): string {
  // The brief's original version rendered only the bare provider name for the three
  // non-router providers ("Provider claude — one client, no routing."). Task 1's review
  // added `activeClient` (populated for claude / openai-compatible / private-llm, undefined
  // for router — the router's answer is `backends[]` instead) precisely so this page could
  // show the one active client, not merely name it (design §4.2). Reusing nodeRows() here —
  // the same helper the inbound/outbound tables use — means this table and those tables
  // can never render a node's fields differently from one another.
  const router =
    t.provider !== "router"
      ? `<p class="meta">Provider <code translate="no">${esc(t.provider)}</code> — one client, no routing.</p>` +
        nodeRows(t.activeClient ? [t.activeClient] : [])
      : t.registryError
        ? empty("The backend registry could not be read.", t.registryError)
        : backendRows(t.backends) +
          `<p class="meta">Only <code translate="no">private-llm</code> backends traverse SQS to ` +
          `<code translate="no">llm-worker</code>; <code translate="no">claude</code> and ` +
          `<code translate="no">openai-compatible</code> backends are called directly from the agent.</p>`;

  return layout(
    "Topology",
    `<h1>Dependency map</h1>
     <p class="meta">Read from this agent's own configuration, plus the tool list
       <code translate="no">devops-mcp-server</code> sent when the agent connected. Nothing here is
       probed — no call leaves the process.</p>
     ${zoom(topologyDiagram(t), nonce)}
     ${section(ICON.inbound, "Inbound")}
     ${nodeRows(t.inbound, "in")}
     ${section(ICON.outbound, "Outbound")}
     ${nodeRows(t.outbound, "out")}
     ${section(ICON.plug, "MCP tools")}
     ${capabilityRows(t.capabilities)}
     ${section(ICON.chip, "LLM backends")}
     ${router}`,
    "/topology"
  );
}
