/**
 * /memory — what the agent remembers, read-only (2026-10-20).
 *
 * Two kinds of memory, two halves of the page, because they answer different questions:
 *   - long-term, per alert key (alertname + namespace, the key IncidentMemory.recall() reads by):
 *     human-confirmed learnings, the agent's own past RCAs, past remediations and their verdicts —
 *     and, on a key's page, the exact text recall would put in front of the model;
 *   - conversation, per Slack thread (Redis): the window the model reads on the thread's next turn.
 *
 * Tool results are never printed past their first line. They are raw cluster output — a
 * ConfigMap's data is one call away — and the full record already has a home, the trace.
 */
import type { Message } from "../agent/llm/types.js";
import type { ThreadMemory, ThreadSummary } from "../agent/memory/index.js";
import { cell, esc, fmtInt, headers, table, timeTag } from "./html.js";
import { inlineMrkdwn } from "./rca.js";
import type { MemoryKeyDetail, MemoryKeyPage, MemoryKeyRow } from "./queries.js";
import { ICON, badge, breakable, dash, empty, pageHead, pager, panel, section, severityBadge, statList, toneAttr } from "./parts.js";
import { layout } from "./layout.js";

export interface MemoryFilters { page: number; alertname: string | null; namespace: string | null }

/** The link to one key's page. No `ns` is the NULL-namespace key, never "any namespace". */
export const keyHref = (alertname: string, namespace: string | null): string => {
  const q = new URLSearchParams({ name: alertname });
  if (namespace !== null) q.set("ns", namespace);
  return `/memory/alert?${q.toString()}`;
};

const nsLabel = (ns: string | null): string => (ns === null ? `<span class="when">no namespace</span>` : esc(ns));

/** "1h 6m" — how long Redis keeps the thread. */
export const fmtTtl = (s: number | null): string => {
  if (s === null) return "no expiry";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${s}s`;
};


export function memoryListPage(p: MemoryKeyPage, f: MemoryFilters, now: Date = new Date(), openIncidents?: number): string {
  const qs = (page: number): string => {
    const q = new URLSearchParams();
    if (f.alertname) q.set("alertname", f.alertname);
    if (f.namespace) q.set("namespace", f.namespace);
    if (page > 1) q.set("page", String(page));
    const s = q.toString();
    return s ? `/memory?${s}` : "/memory";
  };
  const filtered = !!(f.alertname || f.namespace);
  const row = (r: MemoryKeyRow): string =>
    `<tr role="row">` +
    cell("Alert", `<a href="${esc(keyHref(r.alertname, r.namespace))}" translate="no">${esc(r.alertname)}</a>`, "primary") +
    cell("Namespace", nsLabel(r.namespace)) +
    // A confirmed cause is the strongest tier recall has, so a key that has one says so in words.
    cell("Learned", r.learned > 0 ? badge(`${fmtInt(r.learned)} confirmed`, "ok") : dash) +
    cell("Agent RCAs", esc(fmtInt(r.rcas)), "num") +
    cell(
      "Remediations",
      `${esc(fmtInt(r.remediations))}` +
        (r.recovered || r.worse
          ? ` <span class="roles">${r.recovered ? badge(`${fmtInt(r.recovered)} recovered`, "ok") : ""}${r.worse ? badge(`${fmtInt(r.worse)} worse`, "critical") : ""}</span>`
          : "")
    ) +
    cell("Last seen", timeTag(r.lastSeen, now), "when") +
    `</tr>`;
  const body =
    p.rows.length === 0
      ? empty(
          filtered ? "No remembered alert matches these filters." : "Nothing remembered yet.",
          filtered ? "Clear a filter to see more." : "An alert's investigation is stored once its RCA is posted; @agent learn adds a confirmed cause.",
          ICON.memory
        )
      : table(headers("Alert", "Namespace", "Learned", ["Agent RCAs", "num"], "Remediations", "Last seen"), p.rows.map(row).join(""), "stack");
  return layout(
    "Alert memory",
    `<div class="doc">
       <p class="eyebrow">Agent</p>
       <h1>Alert memory</h1>
       <p class="meta">${p.total ? `${esc(fmtInt(p.total))} alert key${p.total === 1 ? "" : "s"}${filtered ? " match" : " remembered"} · ` : ""}what the agent
         recalls when an alert fires again, keyed the way it recalls it — by alert name and namespace.</p>
     </div>
     <section class="card flush">
     <form class="filters" method="get" action="/memory">
       <label>Alert<input type="text" name="alertname" value="${esc(f.alertname)}" placeholder="KubePodCrashLooping"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <label>Namespace<input type="text" name="namespace" value="${esc(f.namespace)}" placeholder="prod"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <div class="actions"><button type="submit">Apply filters</button>${filtered ? `<a href="/memory">Clear</a>` : ""}</div>
     </form>
     ${body}
     ${pager(p, f, qs, "alert")}
     </section>`,
    { current: "/memory", openIncidents }
  );
}

export function memoryKeyPage(
  key: { alertname: string; namespace: string | null },
  recall: { incidents: string; remediations: string } | null,
  d: MemoryKeyDetail,
  now: Date = new Date(),
  openIncidents?: number,
  names?: ReadonlyMap<string, string>
): string {
  const pre = (text: string, none: string): string =>
    text.trim() ? `<pre class="mem-pre" translate="no">${esc(text)}</pre>` : `<p class="meta">${esc(none)}</p>`;
  const recallBlock =
    recall === null
      ? `<p class="meta">The agent's recall is not reachable from this process, so the text it would read cannot be shown.</p>`
      : pre(recall.incidents, "No past incident or confirmed cause is recalled for this key.") +
        pre(recall.remediations, "No past remediations are recalled for this key.");
  const incidentLink = (id: number): string => `<a href="/incidents/${esc(id)}">#${esc(id)}</a>`;
  const learned = d.learned.length
    ? table(
        headers("Confirmed", "Root cause", "Action", "Outcome", "Incident"),
        d.learned
          .map(
            (l) =>
              `<tr role="row">${cell("Confirmed", `${timeTag(l.createdAt, now)}${l.slackUser ? ` <span class="when">by ${esc(names?.get(l.slackUser) ?? l.slackUser)}</span>` : ""}`, "when")}` +
              cell("Root cause", esc(l.confirmedRootCause ?? "—")) + cell("Action", esc(l.actionTaken ?? "—")) +
              cell("Outcome", l.outcome ? badge(l.outcome) : `<span class="meta">unknown</span>`) + cell("Incident", incidentLink(l.incidentId)) + `</tr>`
          )
          .join(""),
        "stack"
      )
    : empty("Nobody has confirmed a cause for this alert yet.", "@agent learn in an incident's thread stores one, and it is recalled first.", ICON.speech);
  const rcas = d.rcas.length
    ? table(
        headers("When", "Root cause", "Severity", "Confidence", "Incident"),
        d.rcas
          .map(
            (r) =>
              `<tr role="row">${cell("When", timeTag(r.createdAt, now), "when")}${cell("Root cause", esc((r.rootCause ?? "—").split("\n")[0]))}` +
              cell("Severity", severityBadge(r.severity)) + cell("Confidence", esc(r.confidence ?? "—")) + cell("Incident", incidentLink(r.incidentId)) + `</tr>`
          )
          .join(""),
        "stack"
      )
    : empty("No agent RCA is stored for this key.", "Stored once an alert's RCA is posted.", ICON.memory);
  const rems = d.remediations.length
    ? table(
        headers("When", "Remediation", "Status", "Verdict", "Incident"),
        d.remediations
          .map(
            (r) =>
              `<tr role="row">${cell("When", timeTag(r.createdAt, now), "when")}${cell("Remediation", esc(r.summary))}` +
              cell("Status", badge(r.status)) + cell("Verdict", r.verdict ? badge(r.verdict) : `<span class="meta">not verified</span>`) + cell("Incident", incidentLink(r.incidentId)) + `</tr>`
          )
          .join(""),
        "stack"
      )
    : empty("No executed remediation for this key.", "Only remediations that ran are memory.", ICON.wrench);
  const title = `${key.alertname}${key.namespace === null ? "" : ` · ${key.namespace}`}`;
  return layout(
    title,
    `<div class="doc">
     <p class="eyebrow"><a href="/memory">Alert memory</a></p>
     <h1 translate="no">${esc(key.alertname)}</h1>
     <p class="meta">Namespace ${nsLabel(key.namespace)}</p>
     ${statList([
       { icon: ICON.speech, label: "Confirmed causes", value: fmtInt(d.learned.length), sub: d.learned.length ? "recalled first, as fact" : "none yet — @agent learn adds one" },
       { icon: ICON.memory, label: "Agent RCAs", value: fmtInt(d.rcas.length), sub: "recalled as a hypothesis" },
       { icon: ICON.wrench, label: "Remediations", value: fmtInt(d.remediations.length), sub: "that ran on this key" },
       // No tone: the figure is the recoveries. A "worse" verdict is named in the sub-line,
       // where colouring the tile would have painted the good number red.
       {
         icon: ICON.check,
         label: "Recovered",
         value: fmtInt(d.remediations.filter((r) => r.verdict === "recovered").length),
         sub:
           `of ${fmtInt(d.remediations.filter((r) => r.verdict).length)} verified` +
           (d.remediations.some((r) => r.verdict === "worse")
             ? ` · ${fmtInt(d.remediations.filter((r) => r.verdict === "worse").length)} made it worse`
             : ""),
       },
     ])}
     ${section(ICON.memory, "What the agent will read")}
     <p class="meta">The text recall puts in front of the model when this alert fires again, produced by the agent's own recall. The weakest tier — <em>possibly related</em> incidents, matched on the words of the alert's own text — is computed from that text when an alert arrives, so it cannot be shown here.</p>
     ${recallBlock}
     ${panel("Confirmed by people", learned)}
     ${panel("The agent's own RCAs", rcas)}
     ${panel("Remediations and their verdicts", rems)}
     </div>`,
    { current: "/memory", openIncidents }
  );
}

/** The incident a thread was opened for — what the thread is ABOUT, which its timestamp is not. */
export interface ThreadIncident { id: number; alertname: string; severity: string | null; resolved: boolean }

const startedAt = (ts: string): Date => new Date(Number(ts.split(".")[0]) * 1000);
/** A day is the longest a conversation is kept, so it is what a TTL bar is measured against. */
const DAY_S = 24 * 3600;
const ttlBar = (s: number | null): string =>
  s === null ? "" : `<span class="ratio" style="--a:${Math.max(0, Math.min(100, Math.round((s / DAY_S) * 100)))}" aria-hidden="true"><span></span></span>`;
/** At most three carried skills by name; the rest as a count, so a row stays one or two lines. */
const skillChips = (skills: string[]): string =>
  skills.length === 0
    ? dash
    : `<span class="roles">${skills.slice(0, 3).map((s) => badge(s, "")).join("")}${skills.length > 3 ? `<span class="meta">+${fmtInt(skills.length - 3)}</span>` : ""}</span>`;

export function threadsPage(threads: ThreadSummary[], incidents: ReadonlyMap<string, ThreadIncident>, now: Date = new Date(), openIncidents?: number): string {
  const rows = threads
    .map((t) => {
      const inc = incidents.get(t.threadId);
      return (
        `<tr role="row"${inc ? toneAttr(inc.severity) : ""}>` +
        // The alert the thread was opened for is the name a reader recognises; a thread with no
        // incident is a conversation someone started by mentioning the agent.
        cell(
          "Thread",
          `<a href="/memory/threads/${esc(t.threadId)}">${inc ? breakable(inc.alertname) : "Conversation"}</a>` +
            `<div class="sub"><span translate="no">${esc(t.threadId)}</span> · started ${timeTag(startedAt(t.threadId), now)}</div>`,
          "primary"
        ) +
        cell("Messages", esc(fmtInt(t.messages)), "num") +
        cell("Expires in", `${esc(fmtTtl(t.ttlSeconds))}${ttlBar(t.ttlSeconds)}`) +
        cell("RCA sent", t.rcaSent ? badge("rca sent", "ok") : `<span class="meta">no</span>`) +
        cell("Skills carried", skillChips(t.skills)) +
        cell("Incident", inc ? `<a href="/incidents/${esc(inc.id)}">#${esc(inc.id)}</a> ${severityBadge(inc.severity)}` : dash) +
        `</tr>`
      );
    })
    .join("");
  const held = threads.length;
  const messages = threads.reduce((a, t) => a + t.messages, 0);
  const rca = threads.filter((t) => t.rcaSent).length;
  const ttls = threads.map((t) => t.ttlSeconds).filter((s): s is number => s !== null);
  const soonest = ttls.length ? Math.min(...ttls) : null;
  return layout(
    "Conversation memory",
    `${pageHead({
      eyebrow: "Agent",
      title: "Conversation memory",
      lede: "The conversation each Slack thread still holds — what the model reads on that thread's next turn. Kept 24 hours after the last message.",
    })}
     ${statList([
       { icon: ICON.chats, label: "Threads held", value: fmtInt(held), sub: held === 1 ? "one conversation" : "in Redis now" },
       { icon: ICON.layers, label: "Messages", value: fmtInt(messages), sub: held ? `${fmtInt(Math.round(messages / held))} a thread on average` : "none held" },
       { icon: ICON.check, label: "RCA sent", value: fmtInt(rca), sub: `of ${fmtInt(held)} threads` },
       { icon: ICON.repeat, label: "Next to expire", value: soonest === null ? "—" : fmtTtl(soonest), sub: soonest === null ? "nothing expires in-memory" : "then the thread is forgotten" },
     ])}
     ${panel(
       "Threads",
       held
         ? table(headers("Thread", ["Messages", "num"], "Expires in", "RCA sent", "Skills carried", "Incident"), rows, "stack")
         : empty("No conversation is held right now.", "A thread's conversation stays for 24 hours after its last message.", ICON.chats),
       held ? `<span class="meta">newest first</span>` : ""
     )}`,
    { current: "/memory/threads", openIncidents }
  );
}

/** One message as rows of what it holds; a tool result is its size and first line, never more. */
function messageContent(m: Message): string {
  // Text is the model's or the operator's own mrkdwn — the RCA most of all — so it is rendered the
  // way Slack shows it (bold, italics, code), line breaks kept. inlineMrkdwn escapes first.
  const text = (t: string): string => `<div class="mem-text">${inlineMrkdwn(t)}</div>`;
  if (typeof m.content === "string") return text(m.content);
  const calls = m.content.filter((b) => b.type === "tool_use");
  const results = m.content.filter((b) => b.type === "tool_result");
  const rest = m.content.filter((b) => b.type !== "tool_use" && b.type !== "tool_result");
  return (
    rest.map((b) => (b.type === "text" ? text(b.text ?? "") : `<p class="meta">(${esc(b.type)} block)</p>`)).join("") +
    (calls.length
      ? `<ul class="mem-calls">` +
        calls
          .map((b) => {
            const input = JSON.stringify(b.input ?? {});
            return `<li><span class="mem-arrow" aria-hidden="true">→</span><code class="mem-name" translate="no">${esc(b.name ?? "?")}</code> <code class="mem-dim">${esc(input.length > 300 ? `${input.slice(0, 300)}…` : input)}</code></li>`;
          })
          .join("") +
        `</ul>`
      : "") +
    (results.length
      ? `<ul class="mem-calls">` +
        results
          .map((b) => {
            const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            const first = body.split("\n")[0] ?? "";
            return `<li><span class="mem-arrow" aria-hidden="true">←</span><span class="mem-size">${esc(fmtInt(body.length))} chars</span> <code class="mem-dim">${esc(first.length > 160 ? `${first.slice(0, 160)}…` : first)}</code></li>`;
          })
          .join("") +
        `</ul>`
      : "")
  );
}

export function threadPage(t: ThreadMemory | null, inc: ThreadIncident | null, now: Date = new Date(), threadId = t?.threadId ?? "", openIncidents?: number): string {
  const head = (lede: string, tools: string): string =>
    `<header class="page-head"><div class="page-title">` +
    `<p class="eyebrow"><a href="/memory/threads">Conversation memory</a></p>` +
    `<h1>${inc ? breakable(inc.alertname) : "Conversation"}</h1>` +
    `<p class="meta">${lede}</p></div>` +
    (tools ? `<div class="page-tools page-actions">${tools}</div>` : "") +
    `</header>`;
  const trace = `<a class="standalone" href="/api/trace/${esc(threadId)}">Open the trace</a>`;
  const incLink = inc ? `<a class="standalone" href="/incidents/${esc(inc.id)}">Incident #${esc(inc.id)} →</a>` : "";
  if (!t) {
    return layout(
      "Conversation memory",
      `<div class="doc">${head(`Thread <span translate="no">${esc(threadId)}</span>`, incLink + trace)}` +
        empty("This thread holds no conversation any more.", "Conversations expire 24 hours after their last message; the trace keeps the full record.", ICON.chats) +
        `</div>`,
      { current: "/memory/threads", openIncidents }
    );
  }
  // A transcript, not a table: a conversation is read top to bottom by who said it.
  // A user-role message that only carries tool results is the tool talking, not the person.
  const who = (m: Message): string =>
    m.role === "assistant"
      ? "agent"
      : Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b.type === "tool_result")
        ? "tool"
        : m.role;
  const size = (m: Message): number =>
    typeof m.content === "string" ? m.content.length : m.content.reduce((a, b) => a + (b.text?.length ?? 0), 0);
  const turns = t.messages
    .map((m, i) => {
      const role = who(m);
      const calls = Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").length : 0;
      const results = Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result").length : 0;
      const label =
        role === "agent" ? (calls ? `agent · ${fmtInt(calls)} call${calls === 1 ? "" : "s"}` : "agent · answer")
        : role === "tool" ? `tools · ${fmtInt(results)} result${results === 1 ? "" : "s"}`
        : "user";
      const headHtml = `<span class="turn-who">${esc(label)}</span><span class="meta">#${esc(i + 1)}</span>${i === 0 ? badge("pinned", "info") : ""}`;
      // The pinned first message is the alert plus everything the agent was handed with it — time
      // context, the change timeline, recall — often a screen or two. It folds, so the turns
      // that follow are not pushed below the fold; its own heading says what it holds.
      return i === 0 && size(m) > 600
        ? `<li class="turn" data-role="${role}"><details class="turn-fold"><summary class="turn-head">${headHtml}<span class="meta">the alert and its context · ${esc(fmtInt(size(m)))} chars</span></summary>` +
            `<div class="turn-body">${messageContent(m)}</div></details></li>`
        : `<li class="turn" data-role="${role}"><div class="turn-head">${headHtml}</div><div class="turn-body">${messageContent(m)}</div></li>`;
    })
    .join("");
  const agentTurns = t.messages.filter((m) => m.role === "assistant").length;
  const callCount = t.messages.reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").length : 0), 0);
  return layout(
    inc ? `${inc.alertname} · conversation` : "Conversation memory",
    `<div class="doc">
     ${head(`Thread <span translate="no">${esc(t.threadId)}</span> · started ${timeTag(startedAt(t.threadId), now)}. The window the model reads on this thread's next turn, in order — the first message is pinned and trimming never drops it.`, incLink + trace)}
     <div class="detail">
     <aside class="detail-side" aria-label="About this conversation">
     ${statList(
       [
         { label: "Messages", value: fmtInt(t.messages.length), sub: `${fmtInt(agentTurns)} from the agent` },
         { label: "Tool calls", value: fmtInt(callCount), sub: "results show their first line only" },
         { label: "Expires in", value: fmtTtl(t.ttlSeconds), sub: t.ttlSeconds === null ? "held in this process" : "24h after the last message" },
         { label: "RCA sent", value: t.rcaSent ? "Yes" : "No", sub: t.rcaSent ? "follow-ups answer as chat" : "the next alert turn writes one" },
       ],
       "facts"
     )}
     ${
       t.skills.length
         ? `<section class="card skills-carried"><p class="toc-title">Skills carried · ${fmtInt(t.skills.length)}</p>` +
           `<ul class="chips-list">${t.skills.map((s) => `<li><a href="/context/${esc(encodeURIComponent(s))}"><code translate="no">${esc(s)}</code></a></li>`).join("")}</ul></section>`
         : ""
     }
     </aside>
     <div class="detail-main">
     <ol class="transcript">${turns}</ol>
     </div>
     </div>
     </div>`,
    { current: "/memory/threads", openIncidents }
  );
}
