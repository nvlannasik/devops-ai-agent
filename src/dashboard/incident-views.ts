import { costUsd, type Price } from "../agent/llm/pricing.js";
import { cell, esc, fmtAgo, fmtDate, fmtDuration, fmtInt, fmtLatency, headers, table, timeTag } from "./html.js";
import { renderRca } from "./rca.js";
import type { Filters } from "./filters.js";
import type { ChildIncident, FeedbackRow, IncidentDetail, IncidentPage, PostmortemListRow, PostmortemRow, RemediationRow, TimelineEvent, TokenLine } from "./queries.js";
import { renderMarkdown } from "./markdown.js";
import { ICON, badge, breakable, costCell, dash, empty, fmtUsd, pager, section, severityBadge, statList, stateBadge, toneAttr } from "./parts.js";
import { layout } from "./layout.js";
import { incidentTable } from "./overview-views.js";

export function listPage(
  p: IncidentPage,
  f: Filters,
  now: Date = new Date(),
  openIncidents?: number
): string {
  const qs = (page: number): string => {
    const q = new URLSearchParams();
    if (f.from) q.set("from", f.from.toISOString().slice(0, 10));
    if (f.to) q.set("to", f.to.toISOString().slice(0, 10));
    if (f.alertname) q.set("alertname", f.alertname);
    if (f.namespace) q.set("namespace", f.namespace);
    if (f.severity) q.set("severity", f.severity);
    if (f.resolved !== null) q.set("resolved", String(f.resolved));
    if (f.verdict) q.set("verdict", f.verdict);
    // page=1 is omitted: a link that restates the default is a query string the reader has to
    // read past to see which filters are actually on.
    if (page > 1) q.set("page", String(page));
    const s = q.toString();
    return s ? `/incidents?${s}` : "/incidents";
  };

  // Dropping a filter always returns to page 1: the result set is about to be larger, and
  // page 7 of the old one is not a place in the new one.
  const qsWithout = (key: string): string => {
    const q = new URLSearchParams(qs(1).split("?")[1] ?? "");
    q.delete(key);
    const out = q.toString();
    return out ? `/incidents?${out}` : "/incidents";
  };

  const sel = (v: string, cur: string | null, label: string): string =>
    `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;

  const filtered = !!(f.from || f.to || f.alertname || f.namespace || f.severity || f.resolved !== null || f.verdict);

  // The one filter with no field in the form, so the one that would otherwise be invisible:
  // a reader who followed "Made it worse" would land on a shortened list with nothing saying
  // why. A chip states it and removes it — the × drops the verdict and keeps everything else,
  // which is what makes it a chip rather than a second Clear.
  const chips = f.verdict
    ? `<ul class="chips"><li><span class="chip-key">verdict</span>${esc(f.verdict)}` +
      `<a href="${esc(qsWithout("verdict"))}" aria-label="Remove the ${esc(f.verdict)} verdict filter">×</a>` +
      `</li></ul>`
    : "";

  // The three views on-call actually switches between, one click each. The form's State select
  // stays (it combines with the other fields); this is the same parameter, as links.
  const stateHref = (v: boolean | null): string => {
    const q = new URLSearchParams(qsWithout("resolved").split("?")[1] ?? "");
    if (v !== null) q.set("resolved", String(v));
    const out = q.toString();
    return out ? `/incidents?${out}` : "/incidents";
  };
  const stateLink = (v: boolean | null, label: string): string =>
    `<a href="${esc(stateHref(v))}"${f.resolved === v ? ` aria-current="true"` : ""}>${label}</a>`;
  const stateSwitch =
    `<nav class="seg" aria-label="Incident state">` +
    stateLink(null, "All") +
    stateLink(false, `Firing${openIncidents ? ` <span class="seg-count">${esc(fmtInt(openIncidents))}</span>` : ""}`) +
    stateLink(true, "Resolved") +
    `</nav>`;

  // Two different absences. No rows on page 1 means the filters matched nothing; no rows on
  // page 7 means the range ended earlier than the URL claims — usually a bookmark outliving
  // the rows it pointed at — and the way out of that is a link, not a suggestion to filter.
  const nothing =
    f.page > 1
      ? `<p class="empty"><strong>Nothing on page ${esc(f.page)}.</strong>` +
        `This filter matches ${esc(fmtInt(p.total))} incident${p.total === 1 ? "" : "s"}. ` +
        `<a href="${esc(qs(1))}">Go to the first page</a>.</p>`
      : empty("No incidents match these filters.", "Widen the date range, or clear a filter to see more.", ICON.search);

  // The two free-text fields take identifiers, not words: autocomplete off (the browser has
  // no saved value that belongs in "Namespace"), autocapitalize off (a phone would send
  // `Prod`, which matches nothing), spellcheck off (every alert name is a red squiggle).
  return layout(
    "Incidents",
    `<div class="page-head">
       <div>
         <h1>Incidents</h1>
         <p class="meta">${esc(fmtInt(p.total))}${p.capped ? "+" : ""} incident${p.total === 1 ? "" : "s"}${filtered ? " match these filters" : ""}${
           openIncidents ? ` · <strong>${esc(fmtInt(openIncidents))} firing now</strong>` : ""
         }</p>
       </div>
       ${stateSwitch}
     </div>
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
     ${chips}
     ${incidentTable(p.rows, nothing, now)}
     ${pager(p, f, qs)}`,
    {
      current: "/incidents",
      // Only while nothing is filtered and nothing is paged. A refresh reloads the URL, so a
      // filtered view would survive it — but the reader is then WORKING, and a page that
      // reloads under someone mid-way through reading row seven is worse than a stale one.
      // Unfiltered page 1 is the watch view; everything else is a query someone typed.
      refresh: !filtered && f.page === 1,
      openIncidents,
    }
  );
}

/** A Slack id as its name when the lookup had one, the id kept beside it for matching the config. */
const person = (id: string, names?: ReadonlyMap<string, string>): string => {
  const name = names?.get(id);
  return name ? `${esc(name)} <span class="meta" translate="no">${esc(id)}</span>` : `<code translate="no">${esc(id)}</code>`;
};

/** A remediation's params as key = value lines — the JSON was one unbroken token per row. */
const paramList = (params: Record<string, unknown>): string => {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return "";
  return (
    `<dl class="kv" translate="no">` +
    entries
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(typeof v === "string" ? v : JSON.stringify(v))}</dd></div>`)
      .join("") +
    `</dl>`
  );
};

/**
 * http(s) URLs in a result line become links (a GitOps PR is the result someone wants to open).
 * esc() first, then markup on the escaped text: the pattern stops at whitespace, `<` and quotes, so
 * nothing esc() emitted can be pulled into an attribute, and a non-http scheme never matches.
 */
export const linkify = (text: string): string =>
  esc(text).replace(/https?:\/\/[^\s<"']+/g, (u) => `<a href="${u}" rel="noreferrer noopener" target="_blank">${u}</a>`);

/**
 * What the cluster did about a remediation, or why that is not known yet.
 *
 * Four states, and they are not four shades of the same thing:
 *   a verdict          — the check ran and concluded. Badge plus the evidence it read.
 *   still waiting      — a check exists and has not finished. It says when to look again,
 *                        because "pending" with no horizon is indistinguishable from stuck.
 *   never scheduled    — the remediation was proposed and not approved, so nothing was ever
 *                        going to be verified. A dash, not a "pending" that will never resolve.
 *
 * `inconclusive` gets no tone (see the TONE map): it means the evidence said nothing either
 * way, and colouring it would turn an absence of evidence into a finding.
 */
function verdictCell(r: RemediationRow, now: Date): string {
  if (r.verdict) {
    return (
      badge(r.verdict) +
      (r.verdict_detail ? `<div class="sub">${esc(r.verdict_detail)}</div>` : "")
    );
  }
  // A GitOps PR's check (migrations/016): waiting for the merge + Flux sync is not "checking",
  // and one that expired was never verified — no verdict, said plainly.
  if (r.check_status === "awaiting") {
    return `<span class="badge">waiting for the PR</span><div class="sub">verification starts once Flux runs the change</div>`;
  }
  if (r.check_status === "expired") {
    return `<span class="badge">not applied</span>` + (r.verdict_detail ? `<div class="sub">${esc(r.verdict_detail)}</div>` : "");
  }
  if (r.check_status) {
    // fmtAgo is no use here: due_at is in the FUTURE, and fmtAgo clamps a future instant to
    // "just now" so a check due in four minutes would read as one that already ran. The wait
    // is a duration, so it is formatted as one — and a due time already past says so rather
    // than counting backwards, because that is a poller that has stopped.
    const wait = r.due_at ? r.due_at.getTime() - now.getTime() : null;
    const sub =
      wait === null ? "" : wait > 0 ? `next check in ${fmtDuration(wait)}` : "check overdue";
    return (
      `<span class="badge">checking</span>` +
      (sub ? `<div class="sub">${esc(sub)}</div>` : "")
    );
  }
  return dash;
}

export function detailPage(
  d: {
    incident: IncidentDetail;
    remediations: RemediationRow[];
    feedback: FeedbackRow[];
    /** The run's trace (agent/trace). Absent or empty for incidents older than the recorder. */
    timeline?: TimelineEvent[];
    /** llm_usage for this incident, per backend and model. */
    usage?: TokenLine[];
    /** Related alerts correlate() merged into this incident's thread (agent/correlation). */
    children?: ChildIncident[];
    /** Whether a postmortem draft exists for this incident (migrations/015) — never the draft
     *  itself, which the dashboard reads directly on its own route rather than here. */
    hasPostmortem?: boolean;
    /** Slack display names for the ids in the rows (SlackApp.userProfiles); an id without one shows as itself. */
    names?: ReadonlyMap<string, string>;
  },
  now: Date = new Date(),
  openIncidents?: number,
  prices: ReadonlyMap<string, Price> = new Map()
): string {
  const i = d.incident;
  const who = (id: string | null): string => (id ? person(id, d.names) : dash);
  // app_redirect needs no workspace domain, so the deep link costs no configuration.
  // encodeURIComponent() first (safe *inside* the URL — a stray & or # in a component
  // can't inject a second query param or a fragment), then esc() on the whole string
  // (safe *inside* the href attribute). Both layers are required; neither is redundant.
  const slack =
    i.channel && i.thread_ts
      ? `<a class="standalone" href="${esc(`https://slack.com/app_redirect?channel=${encodeURIComponent(i.channel)}&message_ts=${encodeURIComponent(i.thread_ts)}`)}">Open the Slack thread →</a>`
      : "";

  // Read-only on this page too: the draft itself (and its request) only ever happens in Slack
  // (`@agent postmortem`) — this is a link to the already-stored draft, shown only when one
  // exists so a page with nothing to show does not advertise a dead end.
  const postmortemLink = d.hasPostmortem
    ? `<a class="standalone" href="/incidents/${esc(i.id)}/postmortem">Postmortem draft →</a>`
    : "";

  // Both of these are records of five fields, not lists to scan, so below 46rem they stack into
  // captioned pairs rather than scrolling sideways — five columns on a phone put Result and
  // Executed past the right edge, which on a remediation table means the outcome of the change
  // is the part you cannot see. Five is also why the threshold is the incident list's and not
  // the lower one these tables used to take: they ask for ~740px of columns, so between 40 and
  // 46rem they were still a table and still scrolling. headers() keeps the <th> text and the
  // cell captions the same
  // string: they are the same label, and a table whose captions have drifted from its headers
  // is one nobody notices is wrong.
  const remediations =
    d.remediations.length === 0
      ? empty("No remediation proposed.", "The agent investigated this alert but suggested no change.", ICON.wrench)
      : table(
          headers("Action", "Status", "Verdict", "Approved by", "Executed"),
          d.remediations
            .map(
              // The row is toned by its VERDICT, and the fallback is narrower than it looks.
              // They disagree exactly where it matters: a restart that returned 200 and fixed
              // nothing is a green status over an amber verdict, and the spine has to carry the
              // one that describes the cluster.
              //
              // A check that exists but has not concluded tones the row NOT AT ALL — it does not
              // fall back to the status. Falling back put a green spine on a row whose outcome
              // is still being measured, which is the exact masquerade this feature exists to
              // stop: `succeeded` reading as "it worked" before anything has looked.
              // The status is only the whole story where no check will ever run — an unapproved
              // proposal, or an action that errored before one was scheduled.
              (r) => `<tr role="row"${toneAttr(r.verdict ?? (r.check_status ? "" : r.status))}>` +
                cell("Action", `<span translate="no">${esc(r.action)}</span>${paramList(r.params)}`, "mono") +
                // `result` is what the call said, so it belongs under the call's own badge
                // rather than in a column of its own — which is also what makes room for the
                // verdict without taking this table to six columns.
                cell(
                  "Status",
                  badge(r.status) + (r.result ? `<div class="sub">${linkify(r.result)}</div>` : "")
                ) +
                cell("Verdict", verdictCell(r, now)) +
                cell("Approved by", who(r.approved_by)) +
                cell("Executed", timeTag(r.executed_at, now), "when") +
                `</tr>`
            )
            .join(""),
          "stack"
        );

  // The change timeline (agent/changes, migrations/012): what changed in the namespace in the
  // 24h before the alert, collected before the investigation started and stored on the row — a
  // source that could not be read is named rather than silently dropped, the same "unknown ≠
  // none" rule the timeline module itself states.
  const ch = i.changes;
  const changes = !ch
    ? ""
    : section(ICON.changes, "Recent changes") +
      (ch.changes.length + ch.commits.length === 0
        ? `<p class="sub">No changes found in the sources that were read.</p>`
        : table(
            headers("When", "What", "Change"),
            [
              ...ch.changes.map((c) =>
                `<tr role="row">${cell("When", timeTag(new Date(c.at), now), "when")}` +
                cell("What", `<span translate="no">${esc(c.workload)}</span>`, "mono") +
                cell("Change", esc(`${c.kind}${c.revision ? ` rev ${c.revision}` : ""}${(c.diff ?? []).map((d) => ` · ${d.field} ${d.from} → ${d.to}`).join("")}`)) +
                `</tr>`),
              ...ch.commits.map((c) => {
                // esc() stops markup injection, not a scheme — a `javascript:` URL from the
                // GitOps worker's `history` op would still render as a clickable link otherwise.
                const sha7 = esc(c.sha.slice(0, 7));
                const link = /^https?:\/\//.test(c.url) ? `<a href="${esc(c.url)}">${sha7}</a>` : sha7;
                return `<tr role="row">${cell("When", timeTag(new Date(c.at), now), "when")}` +
                  cell("What", link, "mono") +
                  cell("Change", esc(`${c.message} — ${c.author}`)) +
                  `</tr>`;
              }),
            ].join(""),
            "stack"
          )) +
      (ch.unread.length ? `<p class="sub">Not read: ${esc(ch.unread.join("; "))}</p>` : "");

  // Related alerts (agent/correlation, migrations/013): other alert groups correlate() matched
  // to the same open incident and filed as children of this row, same Slack thread. A child
  // carries its own "Merged into #N" line on its own page instead — this list only ever runs
  // one level, there is no section nesting a tree.
  const children = d.children ?? [];
  const relatedAlerts =
    children.length === 0
      ? ""
      : section(ICON.link, "Related alerts") +
        table(
          headers("Alertname", "Subjects", "Started", "Status"),
          children
            .map(
              (c) => `<tr role="row">` +
                cell("Alertname", `<a href="/incidents/${esc(c.id)}">${breakable(c.alertname)}</a>`, "primary") +
                cell("Subjects", esc(c.subjects.length ? c.subjects.join(", ") : "—")) +
                cell("Started", timeTag(c.created_at, now), "when") +
                cell("Status", stateBadge(c.resolved_at)) +
                `</tr>`
            )
            .join(""),
          "stack"
        );

  // The mirror of the above: THIS incident is a child, merged into another thread. The row's
  // own rca already says so in prose ("Merged into the incident in this thread…") but a reader
  // on this page did not navigate from the parent and has no way to reach it without this link.
  const mergedInto = i.parent_id
    ? `<a class="standalone" href="/incidents/${esc(i.parent_id)}">Merged into #${esc(i.parent_id)} →</a>`
    : "";

  const feedback =
    d.feedback.length === 0
      ? empty("No on-call feedback yet.", "Reply in the Slack thread to record what actually fixed it.", ICON.speech)
      : table(
          headers("From", "Confirmed root cause", "Action taken", "Outcome", "When"),
          d.feedback
            .map(
              (r) => `<tr role="row"${toneAttr(r.outcome)}>` +
                cell("From", who(r.slack_user)) +
                cell("Confirmed root cause", esc(r.confirmed_root_cause ?? "—")) +
                cell("Action taken", esc(r.action_taken ?? "—")) +
                cell("Outcome", r.outcome ? badge(r.outcome) : dash) +
                cell("When", timeTag(r.created_at, now), "when") +
                `</tr>`
            )
            .join(""),
          "stack"
        );

  return layout(
    i.alertname,
    // The id is a real identifier, so it earns the caption slot above the title. The sections
    // below it are not numbered: they are facts about one incident, not a sequence.
    // .doc is the same wrapper the skill page uses, and for the same reason: laid straight into
    // <main> these blocks are loose full-width bands sized only by their content, not one
    // document. See the .doc rule in styles.ts.
    `<div class="doc">
     <p class="eyebrow">Incident #${esc(i.id)}</p>
     <!-- breakable(), not esc(): the same CamelCase break points the list offers. The h1's
          overflow-wrap: anywhere is only the floor, and a floor breaks mid-word —
          "KubernetesContainerOo / mKiller" at 390px, while the same string in the table below
          broke at the hump. One name, two break rules, on one page. -->
     <h1>${breakable(i.alertname)}</h1>
     <div class="title-meta">
       ${severityBadge(i.severity)}
       ${stateBadge(i.resolved_at)}
       ${mergedInto || slack || postmortemLink ? `<span class="page-actions">${mergedInto}${slack}${postmortemLink}</span>` : ""}
     </div>
     ${statList(
       [
         { label: "Namespace", value: i.namespace ?? "—", sub: i.confidence ? `${i.confidence} confidence` : "unrated" },
         // The figure this page made a reader compute. Both timestamps were on the shelf and
         // the interval between them — the only number that says how bad this incident WAS —
         // was not, so it had to be worked out by subtracting one tile from another.
         // Still firing is not a duration of zero: the incident has been open for this long and
         // is not finished, which the sub-line says rather than the value pretending otherwise.
         {
           label: i.resolved_at ? "Time to resolve" : "Open for",
           value: fmtDuration(
             (i.resolved_at ? i.resolved_at.getTime() : now.getTime()) - i.created_at.getTime()
           ),
           sub: i.resolved_at ? "fired to resolved" : "still firing",
           tone: i.resolved_at ? undefined : "warning",
         },
         { label: "Fired", value: fmtAgo(i.created_at, now), sub: fmtDate(i.created_at) },
         { label: "Resolved", value: i.resolved_at ? fmtAgo(i.resolved_at, now) : "—", sub: i.resolved_at ? fmtDate(i.resolved_at) : "not yet" },
       ],
       "facts"
     )}
     ${section(ICON.search, "Root cause analysis")}
     ${
       i.rca && i.rca.trim()
         ? renderRca(i.rca)
         : empty("No analysis recorded.", "The investigation ended before it produced one — the Slack thread has the run.", ICON.search)
     }
     ${changes}
     ${relatedAlerts}
     ${section(ICON.wrench, "Remediation")}
     ${remediations}
     ${section(ICON.speech, "On-call feedback")}
     ${feedback}
     ${usageSection(d.usage ?? [], prices)}
     ${timelineSection(d.timeline ?? [])}
     </div>`,
    { current: "/incidents", openIncidents }
  );
}

/**
 * The stored postmortem draft (migrations/015, spec 2026-10-14-postmortem-draft-design §5) —
 * read-only, same as every other page here. The draft itself is only ever produced by
 * `@agent postmortem` in the incident's Slack thread; this page and the `.md` download route
 * next to it are the only two ways the dashboard touches the feature. A missing draft is the
 * route's 404 (`errorPage`), never this function — it always renders a real row.
 *
 * `.doc` is the same wrapper `detailPage`/`skillPage` use: a long document laid straight into
 * `<main>` would be a run of full-width bands with nothing declaring it one page.
 */
export function postmortemPage(incidentId: number, pm: PostmortemRow, openIncidents?: number, names?: ReadonlyMap<string, string>): string {
  return layout(
    "Postmortem draft",
    // Prose runs the card's full width; a 68ch measure was tried here and taken back out.
    `<div class="doc pm-doc">
     <p class="eyebrow">Incident #${esc(incidentId)}</p>
     <h1>Postmortem draft</h1>
     <div class="title-meta">
       <span class="meta">Generated ${timeTag(pm.createdAt)} by ${pm.requestedBy ? person(pm.requestedBy, names) : "unknown"} · backend ${esc(pm.backend ?? "unknown")}</span>
       <span class="page-actions">
         <a class="standalone" href="/postmortems">← All postmortems</a>
         <a class="standalone" href="/incidents/${esc(incidentId)}">← Incident #${esc(incidentId)}</a>
         <a class="standalone primary" href="/incidents/${esc(incidentId)}/postmortem.md">Download Markdown</a>
       </span>
     </div>
     <p class="meta">A draft: facts (timeline, durations) are rendered from data and the model never
       writes them; the narrative sections are drafted by the model and marked as a draft for
       review. Review before sharing.</p>

     <div class="card md">${renderMarkdown(pm.markdown)}</div>
     </div>`,
    { current: "/postmortems", openIncidents }
  );
}

/**
 * What the harness did on this incident's thread, in order. Tool results are their size and
 * first line only — a raw result can be 512K, and the full trace is one request away at
 * /api/trace/<thread>. A delegate's events say which delegate.
 */
/** What this investigation cost (2026-10-08): its llm_usage rows, priced by the operator's prices. */
/**
 * /postmortems: every incident that has a draft, newest draft first — one row per incident, with
 * how many times `@agent postmortem` was run on it. Like the draft page, it only reads: a draft is
 * made in the incident's Slack thread, so the empty state says that rather than offering a button.
 */
export function postmortemsPage(rows: PostmortemListRow[], now: Date = new Date(), openIncidents?: number, names?: ReadonlyMap<string, string>): string {
  const body = rows
    .map(
      (r) => `<tr role="row"${toneAttr(r.severity)}>
      ${cell("Drafted", timeTag(r.createdAt, now), "when")}
      ${cell("Incident", `<a href="/incidents/${esc(r.incidentId)}/postmortem">${breakable(r.alertname)}</a>` +
        `<div class="sub"><a href="/incidents/${esc(r.incidentId)}">Incident #${esc(r.incidentId)}</a></div>`, "primary")}
      ${cell("Namespace", esc(r.namespace ?? "—"), "ns mono")}
      ${cell("Severity", severityBadge(r.severity), "sev")}
      ${cell("Requested by", r.requestedBy ? person(r.requestedBy, names) : `<span class="meta">unknown</span>`)}
      ${cell("Backend", esc(r.backend ?? "unknown"), "mono")}
      ${cell("Revisions", esc(r.revisions), "num")}
    </tr>`
    )
    .join("");
  const list = rows.length
    ? table(headers("Drafted", "Incident", "Namespace", "Severity", "Requested by", "Backend", ["Revisions", "num"]), body, "stack")
    : empty(
        "No postmortem drafts yet.",
        "Mention the agent with @agent postmortem in an incident's Slack thread, and the draft appears here.",
        ICON.postmortem
      );
  return layout(
    "Postmortems",
    `<div class="doc">
       <p class="eyebrow">Monitor</p>
       <h1>Postmortems</h1>
       <p class="meta">${rows.length ? `${esc(fmtInt(rows.length))} incident${rows.length === 1 ? "" : "s"} with a draft · ` : ""}the newest draft
         for each. Facts (timeline, durations) come from recorded data; the narrative is drafted by the model. Review before sharing.</p>
     </div>
     ${list}`,
    { current: "/postmortems", openIncidents }
  );
}

function usageSection(usage: TokenLine[], prices: ReadonlyMap<string, Price>): string {
  if (usage.length === 0) return "";
  const rows = usage
    .map(
      (b) =>
        `<tr role="row">` +
        cell("Backend", `<code translate="no">${esc(b.backend)}</code>`, "primary") +
        cell("Calls", fmtInt(b.calls), "num") +
        cell("Input", b.input + b.output === 0 ? `<span class="meta">not reported</span>` : fmtInt(b.input), "num") +
        cell("Output", b.input + b.output === 0 ? "—" : fmtInt(b.output), "num") +
        cell("Cost", costCell(prices, b), "num") +
        `</tr>`
    )
    .join("");
  const priced = usage.map((b) => costUsd(prices.get(b.backend), b)).filter((c): c is number => c !== null);
  const total = priced.length ? `<span class="meta">${fmtUsd(priced.reduce((a, b) => a + b, 0))} on priced backends</span>` : "";
  return `${section(ICON.chip, "LLM usage", total)}
    ${table(headers("Backend", ["Calls", "num"], ["Input", "num"], ["Output", "num"], ["Cost", "num"]), rows, "pairs")}`;
}

function timelineSection(all: TimelineEvent[]): string {
  // start/end bracket a run and carry nothing a reader acts on; on a phone they were a third of
  // the section's height.
  const events = all.filter((e) => e.kind !== "start" && e.kind !== "end");
  if (events.length === 0) return "";
  const took = (e: TimelineEvent): string => (e.ms === null || e.ms === undefined ? "" : ` <span class="meta">· ${fmtLatency(e.ms)}</span>`);
  const what = (e: TimelineEvent): string => {
    if (e.kind === "tool") {
      const size = e.size === null ? `<span class="meta">error</span>` : `<span class="meta">${fmtInt(e.size)} chars</span>`;
      const first = e.head ? `<div class="meta">${esc(e.head.split("\n")[0]!.slice(0, 160))}</div>` : "";
      return `<code translate="no">${esc(e.name ?? "")}</code> ${size}${took(e)}${first}`;
    }
    if (e.kind === "llm") return `<code translate="no">${esc(e.name ?? "llm")}</code>${took(e)}`;
    if (e.kind === "gate") {
      return (
        `<code translate="no">${esc(e.name ?? "")}</code> → <strong>${esc(e.outcome ?? "")}</strong>` +
        (e.detail ? ` <span class="meta">${esc(e.detail)}</span>` : "")
      );
    }
    return e.name ? `<span class="meta">${esc(e.name)}</span>` : "";
  };
  const rows = events
    .map(
      (e) =>
        `<tr role="row">` +
        cell("Run", `<span class="meta">${esc(e.threadTs.includes("/") ? e.threadTs.split("/")[1]! : "main")}</span>`) +
        cell("Event", esc(e.kind)) +
        cell("What", what(e)) +
        `</tr>`
    )
    .join("");
  return `${section(ICON.harness, "What the harness did", '<span class="meta">from the investigation trace</span>')}
    ${table(headers("Run", "Event", "What"), rows, "pairs")}`;
}
