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
import type { MemoryKeyDetail, MemoryKeyPage, MemoryKeyRow } from "./queries.js";
import { ICON, empty, layout, pager, section } from "./views.js";

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

const tabs = (current: "keys" | "threads"): string =>
  `<nav class="seg" aria-label="Memory">` +
  `<a href="/memory"${current === "keys" ? ` aria-current="page"` : ""}>By alert</a>` +
  `<a href="/memory/threads"${current === "threads" ? ` aria-current="page"` : ""}>Conversations</a>` +
  `</nav>`;

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
    cell("Learned", esc(fmtInt(r.learned))) +
    cell("Agent RCAs", esc(fmtInt(r.rcas))) +
    cell("Remediations", `${esc(fmtInt(r.remediations))}` +
      (r.recovered || r.worse ? ` <span class="when">${esc(r.recovered)} recovered · ${esc(r.worse)} worse</span>` : "")) +
    cell("Last seen", timeTag(r.lastSeen, now), "when") +
    `</tr>`;
  const body =
    p.rows.length === 0
      ? empty(
          filtered ? "No remembered alert matches these filters." : "Nothing remembered yet.",
          filtered ? "Clear a filter to see more." : "An alert's investigation is stored once its RCA is posted; @agent learn adds a confirmed cause.",
          ICON.memory
        )
      : table(headers("Alert", "Namespace", "Learned", "Agent RCAs", "Remediations", "Last seen"), p.rows.map(row).join(""), "stack");
  return layout(
    "Memory",
    `<h1>Memory</h1>
     <p class="meta">What the agent recalls when an alert fires again, keyed the way it recalls it — by alert name and namespace. Read-only.</p>
     ${tabs("keys")}
     <form class="filters" method="get" action="/memory">
       <label>Alert<input type="text" name="alertname" value="${esc(f.alertname)}" placeholder="KubePodCrashLooping"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <label>Namespace<input type="text" name="namespace" value="${esc(f.namespace)}" placeholder="prod"
         autocomplete="off" autocapitalize="off" spellcheck="false"></label>
       <div class="actions"><button type="submit">Apply filters</button>${filtered ? `<a href="/memory">Clear</a>` : ""}</div>
     </form>
     ${body}
     ${pager(p, f, qs, "alert")}`,
    { current: "/memory", openIncidents }
  );
}

export function memoryKeyPage(
  key: { alertname: string; namespace: string | null },
  recall: { incidents: string; remediations: string } | null,
  d: MemoryKeyDetail,
  now: Date = new Date(),
  openIncidents?: number
): string {
  const pre = (text: string, none: string): string =>
    text.trim() ? `<pre class="mem-pre" translate="no">${esc(text)}</pre>` : `<p class="when">${esc(none)}</p>`;
  const recallBlock =
    recall === null
      ? `<p class="when">The agent's recall is not reachable from this process, so the text it would read cannot be shown.</p>`
      : pre(recall.incidents, "No past incident or confirmed cause is recalled for this key.") +
        pre(recall.remediations, "No past remediations are recalled for this key.");
  const incidentLink = (id: number): string => `<a href="/incidents/${esc(id)}">#${esc(id)}</a>`;
  const learned = d.learned.length
    ? table(
        headers("Confirmed", "Root cause", "Action", "Outcome", "Incident"),
        d.learned
          .map(
            (l) =>
              `<tr role="row">${cell("Confirmed", `${timeTag(l.createdAt, now)}${l.slackUser ? ` <span class="when">by ${esc(l.slackUser)}</span>` : ""}`, "when")}` +
              cell("Root cause", esc(l.confirmedRootCause ?? "—")) + cell("Action", esc(l.actionTaken ?? "—")) +
              cell("Outcome", esc(l.outcome ?? "unknown")) + cell("Incident", incidentLink(l.incidentId)) + `</tr>`
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
              cell("Severity", esc(r.severity ?? "—")) + cell("Confidence", esc(r.confidence ?? "—")) + cell("Incident", incidentLink(r.incidentId)) + `</tr>`
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
              cell("Status", esc(r.status)) + cell("Verdict", esc(r.verdict ?? "not verified")) + cell("Incident", incidentLink(r.incidentId)) + `</tr>`
          )
          .join(""),
        "stack"
      )
    : empty("No executed remediation for this key.", "Only remediations that ran are memory.", ICON.wrench);
  const title = `${key.alertname}${key.namespace === null ? "" : ` · ${key.namespace}`}`;
  return layout(
    title,
    `<div class="doc">
     <p class="eyebrow"><a href="/memory">Memory</a></p>
     <h1 translate="no">${esc(key.alertname)}</h1>
     <p class="meta">Namespace ${nsLabel(key.namespace)}</p>
     ${section(ICON.memory, "What the agent will read")}
     <p class="when">The text recall puts in front of the model when this alert fires again, produced by the agent's own recall. The weakest tier — <em>possibly related</em> incidents, matched on the words of the alert's own text — is computed from that text when an alert arrives, so it cannot be shown here.</p>
     ${recallBlock}
     ${section(ICON.speech, "Confirmed by people")}
     ${learned}
     ${section(ICON.memory, "The agent's own RCAs")}
     ${rcas}
     ${section(ICON.wrench, "Remediations and their verdicts")}
     ${rems}
     </div>`,
    { current: "/memory", openIncidents }
  );
}

export function threadsPage(threads: ThreadSummary[], incidents: ReadonlyMap<string, number>, now: Date = new Date(), openIncidents?: number): string {
  const started = (ts: string): Date => new Date(Number(ts.split(".")[0]) * 1000);
  const body = threads.length
    ? table(
        headers("Thread", "Messages", "Expires in", "RCA sent", "Skills carried", "Incident"),
        threads
          .map((t) => {
            const inc = incidents.get(t.threadId);
            return (
              `<tr role="row">` +
              cell("Thread", `<a href="/memory/threads/${esc(t.threadId)}" translate="no">${esc(t.threadId)}</a> <span class="when">${timeTag(started(t.threadId), now)}</span>`, "primary") +
              cell("Messages", esc(fmtInt(t.messages))) +
              cell("Expires in", esc(fmtTtl(t.ttlSeconds))) +
              cell("RCA sent", t.rcaSent ? "yes" : "no") +
              cell("Skills carried", t.skills.length ? t.skills.map((s) => `<code>${esc(s)}</code>`).join(" ") : "—") +
              cell("Incident", inc === undefined ? "—" : `<a href="/incidents/${esc(inc)}">#${esc(inc)}</a>`) +
              `</tr>`
            );
          })
          .join(""),
        "stack"
      )
    : empty("No conversation is held right now.", "A thread's conversation stays for 24 hours after its last message.", ICON.chats);
  return layout(
    "Memory · conversations",
    `<h1>Memory</h1>
     <p class="meta">The conversation each Slack thread still holds — what the model reads on that thread's next turn. Kept 24 hours after the last message.</p>
     ${tabs("threads")}
     ${body}`,
    { current: "/memory", openIncidents }
  );
}

/** One message as rows of what it holds; a tool result is its size and first line, never more. */
function messageContent(m: Message): string {
  if (typeof m.content === "string") return `<div class="mem-text">${esc(m.content)}</div>`;
  return m.content
    .map((b) => {
      if (b.type === "text") return `<div class="mem-text">${esc(b.text ?? "")}</div>`;
      if (b.type === "tool_use") {
        const input = JSON.stringify(b.input ?? {});
        return `<p>Called <code translate="no">${esc(b.name ?? "?")}</code> <code class="when">${esc(input.length > 300 ? `${input.slice(0, 300)}…` : input)}</code></p>`;
      }
      if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        const first = text.split("\n")[0] ?? "";
        return `<p>Tool result, ${esc(fmtInt(text.length))} chars — <code class="when">${esc(first.length > 160 ? `${first.slice(0, 160)}…` : first)}</code></p>`;
      }
      return `<p class="when">(${esc(b.type)} block)</p>`;
    })
    .join("");
}

export function threadPage(t: ThreadMemory | null, incidentId: number | null, now: Date = new Date(), threadId = t?.threadId ?? "", openIncidents?: number): string {
  if (!t) {
    return layout(
      "Memory · conversation",
      `<div class="doc"><p class="eyebrow"><a href="/memory/threads">Conversations</a></p><h1 translate="no">${esc(threadId)}</h1>` +
        empty("This thread holds no conversation any more.", "Conversations expire 24 hours after their last message; the trace keeps the full record.", ICON.chats) +
        `<p><a href="/api/trace/${esc(threadId)}">Open the trace</a></p></div>`,
      { current: "/memory", openIncidents }
    );
  }
  const rows = t.messages
    .map(
      (m, i) =>
        `<tr role="row">` +
        cell("#", `${esc(i + 1)}${i === 0 ? ` <strong>pinned</strong>` : ""}`, "when") +
        cell("From", esc(m.role === "assistant" ? "agent" : m.role)) +
        cell("Holds", messageContent(m)) +
        `</tr>`
    )
    .join("");
  return layout(
    "Memory · conversation",
    `<div class="doc">
     <p class="eyebrow"><a href="/memory/threads">Conversations</a></p>
     <h1 translate="no">${esc(t.threadId)}</h1>
     <p class="meta">Started ${timeTag(new Date(Number(t.threadId.split(".")[0]) * 1000), now)} · ${esc(fmtInt(t.messages.length))} messages · expires in ${esc(fmtTtl(t.ttlSeconds))} · RCA sent: ${t.rcaSent ? "yes" : "no"}` +
      `${t.skills.length ? ` · skills carried: ${t.skills.map((s) => `<code>${esc(s)}</code>`).join(" ")}` : ""}` +
      `${incidentId !== null ? ` · <a href="/incidents/${esc(incidentId)}">incident #${esc(incidentId)}</a>` : ""}</p>
     <p class="when">The window the model reads on this thread's next turn, in order. The first message is pinned — trimming never drops it. Tool results show their size and first line only; the full run is in <a href="/api/trace/${esc(t.threadId)}">the trace</a>.</p>
     ${section(ICON.chats, "Conversation window")}
     ${table(headers("#", "From", "Holds"), rows, "stack")}
     </div>`,
    { current: "/memory", openIncidents }
  );
}
