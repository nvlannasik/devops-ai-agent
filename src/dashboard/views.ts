import { esc, fmtDate, fmtInt, fmtPct } from "./html.js";
import { barChart } from "./svg.js";
import { STYLES } from "./styles.js";
import type { Filters } from "./filters.js";
import type { FeedbackRow, IncidentDetail, IncidentRow, Overview, RemediationRow } from "./queries.js";

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — DevOps AI Agent</title>
<style>${STYLES}</style>
</head><body>
<header class="top">
  <span class="brand">DevOps AI Agent</span>
  <nav><a href="/">Overview</a><a href="/incidents">Incidents</a></nav>
</header>
<main>${body}</main>
</body></html>`;
}

const severityPill = (s: string | null): string =>
  s ? `<span class="pill ${esc(s)}">${esc(s)}</span>` : `<span class="meta">—</span>`;

const statusPill = (s: string): string => `<span class="pill ${esc(s)}">${esc(s)}</span>`;

const metric = (label: string, value: string, sub = ""): string =>
  `<div class="metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>` +
  (sub ? `<div class="sub">${esc(sub)}</div>` : "") + `</div>`;

function incidentTable(rows: IncidentRow[]): string {
  if (rows.length === 0) return `<p class="empty">No incidents in this range yet.</p>`;
  const body = rows
    .map(
      (r) => `<tr>
      <td class="when">${esc(fmtDate(r.created_at))}</td>
      <td><a href="/incidents/${r.id}">${esc(r.alertname)}</a><div class="meta">${esc(r.root_cause ?? "")}</div></td>
      <td>${esc(r.namespace ?? "—")}</td>
      <td>${severityPill(r.severity)}</td>
      <td>${r.resolved_at ? `<span class="pill resolved">resolved</span>` : `<span class="meta">firing</span>`}</td>
    </tr>`
    )
    .join("");
  return `<table><thead><tr>
      <th>When</th><th>Alert</th><th>Namespace</th><th>Severity</th><th>State</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

export function overviewPage(o: Overview, recent: IncidentRow[]): string {
  const remediationTotal = o.remediationSucceeded + o.remediationFailed;
  const feedbackTotal = Object.values(o.feedback).reduce((a, b) => a + b, 0);

  const recurring =
    o.recurring.length === 0
      ? `<p class="empty">Nothing has recurred yet.</p>`
      : `<table><thead><tr><th>Alert</th><th>Namespace</th><th>Count</th><th>Last seen</th></tr></thead><tbody>` +
        o.recurring
          .map(
            (r) => `<tr><td>${esc(r.alertname)}</td><td>${esc(r.namespace ?? "—")}</td>` +
              `<td class="num">${fmtInt(r.n)}</td><td class="when">${esc(fmtDate(r.last_seen))}</td></tr>`
          )
          .join("") +
        `</tbody></table>`;

  return layout(
    "Overview",
    `<h1>Overview <span class="meta">· last 30 days</span></h1>
     <div class="metrics">
       ${metric("Incidents", fmtInt(o.totalIncidents))}
       ${metric("Resolved", fmtPct(o.resolvedIncidents, o.totalIncidents), `${o.resolvedIncidents} of ${o.totalIncidents}`)}
       ${metric("Remediation success", fmtPct(o.remediationSucceeded, remediationTotal), `${o.remediationSucceeded} of ${remediationTotal}`)}
       ${metric("Feedback received", fmtInt(feedbackTotal))}
       ${metric("Confirmed resolved", fmtInt(o.feedback.resolved ?? 0), "by on-call")}
     </div>
     <h2>Incidents per week</h2>
     <div class="card">${barChart(o.weekly, { label: "incidents per week" })}</div>
     <h2>Most recurring</h2>
     ${recurring}
     <h2>Recent incidents</h2>
     ${incidentTable(recent)}`
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

  return layout(
    "Incidents",
    `<h1>Incidents</h1>
     <form class="filters" method="get" action="/incidents">
       <label>From<input type="date" name="from" value="${esc(f.from ? f.from.toISOString().slice(0, 10) : "")}"></label>
       <label>To<input type="date" name="to" value="${esc(f.to ? f.to.toISOString().slice(0, 10) : "")}"></label>
       <label>Alert<input type="text" name="alertname" value="${esc(f.alertname)}" placeholder="KubePodCrashLooping"></label>
       <label>Namespace<input type="text" name="namespace" value="${esc(f.namespace)}" placeholder="prod"></label>
       <label>Severity<select name="severity">
         ${sel("", f.severity ?? "", "any")}${sel("critical", f.severity ?? "", "critical")}${sel("warning", f.severity ?? "", "warning")}${sel("info", f.severity ?? "", "info")}
       </select></label>
       <label>State<select name="resolved">
         ${sel("", f.resolved === null ? "" : String(f.resolved), "any")}
         ${sel("true", f.resolved === null ? "" : String(f.resolved), "resolved")}
         ${sel("false", f.resolved === null ? "" : String(f.resolved), "firing")}
       </select></label>
       <button type="submit">Filter</button>
     </form>
     ${incidentTable(rows)}
     <div class="pager">
       ${f.page > 1 ? `<a href="${esc(qs(f.page - 1))}">← Previous</a>` : ""}
       ${hasMore ? `<a href="${esc(qs(f.page + 1))}">Next →</a>` : ""}
     </div>`
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
      ? `<a href="${esc(`https://slack.com/app_redirect?channel=${encodeURIComponent(i.channel)}&message_ts=${encodeURIComponent(i.thread_ts)}`)}">Open the Slack thread →</a>`
      : "";

  const remediations =
    d.remediations.length === 0
      ? `<p class="empty">No remediation was proposed for this incident.</p>`
      : `<table><thead><tr><th>Action</th><th>Status</th><th>Approved by</th><th>Result</th><th>Executed</th></tr></thead><tbody>` +
        d.remediations
          .map(
            (r) => `<tr><td class="mono">${esc(r.action)}<div class="meta">${esc(JSON.stringify(r.params))}</div></td>` +
              `<td>${statusPill(r.status)}</td><td>${esc(r.approved_by ?? "—")}</td>` +
              `<td>${esc(r.result ?? "—")}</td><td class="when">${esc(fmtDate(r.executed_at))}</td></tr>`
          )
          .join("") +
        `</tbody></table>`;

  const feedback =
    d.feedback.length === 0
      ? `<p class="empty">No on-call feedback recorded.</p>`
      : `<table><thead><tr><th>From</th><th>Confirmed root cause</th><th>Action taken</th><th>Outcome</th><th>When</th></tr></thead><tbody>` +
        d.feedback
          .map(
            (r) => `<tr><td>${esc(r.slack_user ?? "—")}</td><td>${esc(r.confirmed_root_cause ?? "—")}</td>` +
              `<td>${esc(r.action_taken ?? "—")}</td><td>${r.outcome ? statusPill(r.outcome) : "—"}</td>` +
              `<td class="when">${esc(fmtDate(r.created_at))}</td></tr>`
          )
          .join("") +
        `</tbody></table>`;

  return layout(
    i.alertname,
    `<h1>${esc(i.alertname)}</h1>
     <div class="metrics">
       ${metric("Namespace", i.namespace ?? "—")}
       ${metric("Confidence", i.confidence ?? "—")}
       ${metric("Fired", fmtDate(i.created_at))}
       ${metric("Resolved", fmtDate(i.resolved_at))}
     </div>
     <p style="margin-top:var(--sp-4)">${severityPill(i.severity)} ${slack}</p>
     <h2>Root cause analysis</h2>
     <div class="rca">${esc(i.rca)}</div>
     <h2>Remediation</h2>
     ${remediations}
     <h2>On-call feedback</h2>
     ${feedback}`
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p class="empty">${esc(message)}</p>`);
}
