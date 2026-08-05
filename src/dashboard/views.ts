import { esc, fmtDate, fmtInt, fmtPct } from "./html.js";
import { barChart } from "./svg.js";
import { topologyDiagram } from "./topology-svg.js";
import { TOPO_SCRIPT } from "./topology-script.js";
import { STYLES } from "./styles.js";
import type { Filters } from "./filters.js";
import type { FeedbackRow, IncidentDetail, IncidentRow, Overview, RemediationRow } from "./queries.js";
import { SESSION_TTL_MS } from "./auth.js";
import { rowId } from "./topology.js";
import type { BackendNode, Capability, Node as TopoNode, Topology } from "./topology.js";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/incidents", label: "Incidents" },
  { href: "/topology", label: "Topology" },
];

// The two theme-color values are the only colours written outside styles.ts, and they are
// literals because a <meta> attribute cannot read a custom property. They are --bg for each
// scheme; change one and change the other, or the phone's browser chrome stops matching the
// page it sits above.
//
// `chrome: "bare"` is for the pages you can reach without a session — the sign-in form and
// the "not configured" notice. Navigation there is a row of links that all bounce straight
// back to where you already are, and a Sign out button for a session you do not have.
export function layout(title: string, body: string, current = "", chrome: "full" | "bare" = "full"): string {
  const nav = NAV.map(
    (n) => `<a href="${n.href}"${n.href === current ? ` aria-current="page"` : ""}>${n.label}</a>`
  ).join("");
  const bar =
    chrome === "full"
      ? `<nav>${nav}</nav>` +
        `<form class="signout" method="post" action="/logout"><button type="submit">Sign out</button></form>`
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
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <span class="brand" translate="no">devops-ai-agent</span>
  ${bar}
</header>
<main id="main">${body}</main>
<footer class="bottom">${note} The password is one lock; not routing this port from the Ingress is the other. Keep both.</footer>
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

// Every empty state names the fact and then the next move. An empty screen that only says
// "no data" leaves the reader unsure whether the system is broken or simply quiet.
const empty = (headline: string, next: string): string =>
  `<p class="empty"><strong>${esc(headline)}</strong>${esc(next)}</p>`;

const table = (head: string, body: string): string =>
  `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

interface Stat {
  label: string;
  value: string;
  sub?: string;
}
const statList = (items: Stat[], cls = "stats"): string =>
  `<dl class="${cls}">` +
  items
    .map(
      (s) => `<div class="stat"><dt>${esc(s.label)}</dt><dd>${esc(s.value)}` +
        (s.sub ? `<span>${esc(s.sub)}</span>` : "") + `</dd></div>`
    )
    .join("") +
  `</dl>`;

function incidentTable(rows: IncidentRow[], whenEmpty: string): string {
  if (rows.length === 0) return whenEmpty;
  const body = rows
    .map(
      (r) => `<tr${toneAttr(r.severity)}>
      <td class="when">${esc(fmtDate(r.created_at))}</td>
      <td class="primary"><a href="/incidents/${esc(r.id)}">${esc(r.alertname)}</a>${
        r.root_cause ? `<div class="sub">${esc(r.root_cause)}</div>` : ""
      }</td>
      <td class="mono" translate="no">${esc(r.namespace ?? "—")}</td>
      <td>${severityBadge(r.severity)}</td>
      <td>${r.resolved_at ? badge("resolved", "ok") : badge("firing", "")}</td>
    </tr>`
    )
    .join("");
  return table(`<th>When</th><th>Alert</th><th>Namespace</th><th>Severity</th><th>State</th>`, body);
}

export function overviewPage(o: Overview, recent: IncidentRow[]): string {
  const remediationTotal = o.remediationSucceeded + o.remediationFailed;
  const feedbackTotal = Object.values(o.feedback).reduce((a, b) => a + b, 0);

  const recurring =
    o.recurring.length === 0
      ? empty("Nothing has recurred.", "Every alert in the last 30 days fired exactly once.")
      : table(
          `<th>Alert</th><th>Namespace</th><th>Times</th><th>Last seen</th>`,
          o.recurring
            .map(
              (r) => `<tr><td class="primary">${esc(r.alertname)}</td><td class="mono" translate="no">${esc(r.namespace ?? "—")}</td>` +
                `<td class="num">${fmtInt(r.n)}</td><td class="when">${esc(fmtDate(r.last_seen))}</td></tr>`
            )
            .join("")
        );

  return layout(
    "Overview",
    // One composed object, not a rank of identical tiles: the 30-day count set against the
    // weekly series it summarises, with the supporting figures on a shelf underneath. The
    // count and the shape of it are one fact and belong in one frame.
    `<section class="hero">
       <h1 class="eyebrow">Incidents · last 30 days</h1>
       <div class="hero-body">
         <p class="hero-figure">
           <span class="hero-value">${esc(fmtInt(o.totalIncidents))}</span>
           <span class="hero-unit">investigated</span>
         </p>
         <div class="hero-chart">${barChart(o.weekly, { label: "incidents per week" })}</div>
       </div>
       ${statList([
         { label: "Resolved", value: fmtPct(o.resolvedIncidents, o.totalIncidents), sub: `${o.resolvedIncidents} of ${o.totalIncidents}` },
         { label: "Remediation applied", value: fmtPct(o.remediationSucceeded, remediationTotal), sub: `${o.remediationSucceeded} of ${remediationTotal}` },
         { label: "On-call replies", value: fmtInt(feedbackTotal) },
         { label: "Confirmed fixed", value: fmtInt(o.feedback.resolved ?? 0), sub: "by on-call" },
       ])}
     </section>
     <h2>Most recurring</h2>
     ${recurring}
     <h2>Recent incidents<a href="/incidents">All incidents →</a></h2>
     ${incidentTable(recent, empty("No incidents yet.", "The agent posts here once it has investigated its first alert."))}`,
    "/"
  );
}

export function listPage(rows: IncidentRow[], f: Filters, hasMore: boolean): string {
  const qs = (page: number): string => {
    const p = new URLSearchParams();
    if (f.from) p.set("from", f.from.toISOString().slice(0, 10));
    if (f.to) p.set("to", f.to.toISOString().slice(0, 10));
    if (f.alertname) p.set("alertname", f.alertname);
    if (f.namespace) p.set("namespace", f.namespace);
    if (f.severity) p.set("severity", f.severity);
    if (f.resolved !== null) p.set("resolved", String(f.resolved));
    p.set("page", String(page));
    return `/incidents?${p.toString()}`;
  };

  const sel = (v: string, cur: string | null, label: string): string =>
    `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;

  const filtered = !!(f.from || f.to || f.alertname || f.namespace || f.severity || f.resolved !== null);

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
     ${incidentTable(rows, empty("No incidents match these filters.", "Widen the date range, or clear a filter to see more."))}
     <div class="pager">
       ${f.page > 1 ? `<a href="${esc(qs(f.page - 1))}">← Previous</a>` : ""}
       ${hasMore ? `<a href="${esc(qs(f.page + 1))}">Next →</a>` : ""}
       <span class="at">Page ${esc(f.page)}</span>
     </div>`,
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

  const remediations =
    d.remediations.length === 0
      ? empty("No remediation proposed.", "The agent investigated this alert but suggested no change.")
      : table(
          `<th>Action</th><th>Status</th><th>Approved by</th><th>Result</th><th>Executed</th>`,
          d.remediations
            .map(
              (r) => `<tr${toneAttr(r.status)}><td class="mono" translate="no">${esc(r.action)}<div class="sub">${esc(JSON.stringify(r.params))}</div></td>` +
                `<td>${badge(r.status)}</td><td>${esc(r.approved_by ?? "—")}</td>` +
                `<td>${esc(r.result ?? "—")}</td><td class="when">${esc(fmtDate(r.executed_at))}</td></tr>`
            )
            .join("")
        );

  const feedback =
    d.feedback.length === 0
      ? empty("No on-call feedback yet.", "Reply in the Slack thread to record what actually fixed it.")
      : table(
          `<th>From</th><th>Confirmed root cause</th><th>Action taken</th><th>Outcome</th><th>When</th></tr>`,
          d.feedback
            .map(
              (r) => `<tr${toneAttr(r.outcome)}><td>${esc(r.slack_user ?? "—")}</td><td>${esc(r.confirmed_root_cause ?? "—")}</td>` +
                `<td>${esc(r.action_taken ?? "—")}</td><td>${r.outcome ? badge(r.outcome) : dash}</td>` +
                `<td class="when">${esc(fmtDate(r.created_at))}</td></tr>`
            )
            .join("")
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
       "stats boxed"
     )}
     <h2>Root cause analysis</h2>
     <div class="prose"><div class="prose-text">${esc(i.rca)}</div></div>
     <h2>Remediation</h2>
     ${remediations}
     <h2>On-call feedback</h2>
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
        `<th>Dependency</th><th>Endpoint</th><th>Notes</th>`,
        nodes
          .map(
            (n, i) => `<tr${group ? ` id="${rowId(group, i)}"` : ""}${n.configured ? "" : ` data-tone="warning"`}>` +
              `<td class="primary">${esc(n.label)}</td>` +
              `<td class="mono" translate="no">${esc(n.detail)}</td>` +
              `<td class="meta">${esc(n.meta)}${n.configured ? "" : ` ${badge("not configured", "warning")}`}</td></tr>`
          )
          .join("")
      );

const backendRows = (backends: BackendNode[]): string =>
  table(
    `<th>Backend</th><th>Kind</th><th>Model</th><th>Route</th><th>Reached via</th>`,
    backends
      .map(
        (b, i) => `<tr id="${rowId("backend", i)}"><td class="primary">${esc(b.name)}</td>` +
          `<td class="mono" translate="no">${esc(b.kind)}</td>` +
          `<td class="mono" translate="no">${esc(b.model)}</td><td>${badge(b.route, "")}</td>` +
          `<td class="mono" translate="no">${esc(b.endpoint)}</td></tr>`
      )
      .join("")
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
     <h2>Inbound</h2>
     ${nodeRows(t.inbound, "in")}
     <h2>Outbound</h2>
     ${nodeRows(t.outbound, "out")}
     <h2>MCP tools</h2>
     ${capabilityRows(t.capabilities)}
     <h2>LLM backends</h2>
     ${router}`,
    "/topology"
  );
}
