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
import { ICON, badge, dash, empty, pager, section, severityBadge, statList } from "./parts.js";
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
        headers("Thread", ["Messages", "num"], "Expires in", "RCA sent", "Skills carried", "Incident"),
        threads
          .map((t) => {
            const inc = incidents.get(t.threadId);
            return (
              `<tr role="row">` +
              cell("Thread", `<a href="/memory/threads/${esc(t.threadId)}" translate="no">${esc(t.threadId)}</a> <span class="when">${timeTag(started(t.threadId), now)}</span>`, "primary") +
              cell("Messages", esc(fmtInt(t.messages)), "num") +
              cell("Expires in", esc(fmtTtl(t.ttlSeconds))) +
              cell("RCA sent", t.rcaSent ? badge("rca sent", "ok") : `<span class="meta">no</span>`) +
              cell("Skills carried", t.skills.length ? `<span class="roles">${t.skills.map((s) => badge(s, "")).join("")}</span>` : dash) +
              cell("Incident", inc === undefined ? "—" : `<a href="/incidents/${esc(inc)}">#${esc(inc)}</a>`) +
              `</tr>`
            );
          })
          .join(""),
        "stack"
      )
    : empty("No conversation is held right now.", "A thread's conversation stays for 24 hours after its last message.", ICON.chats);
  return layout(
    "Conversation memory",
    `<div class="doc">
       <p class="eyebrow">Agent</p>
       <h1>Conversation memory</h1>
       <p class="meta">${threads.length ? `${esc(fmtInt(threads.length))} thread${threads.length === 1 ? "" : "s"} held · ` : ""}the conversation each Slack thread
         still holds — what the model reads on that thread's next turn. Kept 24 hours after the last message.</p>
     </div>
     ${body}`,
    { current: "/memory/threads", openIncidents }
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
        return `<p>Called <code translate="no">${esc(b.name ?? "?")}</code> <code class="mem-dim">${esc(input.length > 300 ? `${input.slice(0, 300)}…` : input)}</code></p>`;
      }
      if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        const first = text.split("\n")[0] ?? "";
        return `<p>Tool result, ${esc(fmtInt(text.length))} chars — <code class="mem-dim">${esc(first.length > 160 ? `${first.slice(0, 160)}…` : first)}</code></p>`;
      }
      return `<p class="meta">(${esc(b.type)} block)</p>`;
    })
    .join("");
}

export function threadPage(t: ThreadMemory | null, incidentId: number | null, now: Date = new Date(), threadId = t?.threadId ?? "", openIncidents?: number): string {
  if (!t) {
    return layout(
      "Conversation memory",
      `<div class="doc"><p class="eyebrow"><a href="/memory/threads">Conversation memory</a></p><h1 translate="no">${esc(threadId)}</h1>` +
        empty("This thread holds no conversation any more.", "Conversations expire 24 hours after their last message; the trace keeps the full record.", ICON.chats) +
        `<p><a href="/api/trace/${esc(threadId)}">Open the trace</a></p></div>`,
      { current: "/memory/threads", openIncidents }
    );
  }
  // A transcript, not a table: a conversation is read top to bottom by who said it, and a
  // three-column grid made every turn the same grey row. The agent's turns are tinted; the
  // order and the pinned first message are stated in words, not by position alone.
  // A user-role message that only carries tool results is the tool talking, not the person.
  const who = (m: Message): string =>
    m.role === "assistant"
      ? "agent"
      : Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b.type === "tool_result")
        ? "tool"
        : m.role;
  const turns = t.messages
    .map(
      (m, i) =>
        `<li class="turn" data-role="${who(m)}">` +
        `<div class="turn-head"><span class="turn-who">${esc(who(m))}</span>` +
        `<span class="meta">#${esc(i + 1)}</span>${i === 0 ? badge("pinned", "info") : ""}</div>` +
        `<div class="turn-body">${messageContent(m)}</div>` +
        `</li>`
    )
    .join("");
  return layout(
    "Conversation memory",
    `<div class="doc">
     <p class="eyebrow"><a href="/memory/threads">Conversation memory</a></p>
     <h1 translate="no">${esc(t.threadId)}</h1>
     <p class="meta">Started ${timeTag(new Date(Number(t.threadId.split(".")[0]) * 1000), now)} · ${esc(fmtInt(t.messages.length))} messages · expires in ${esc(fmtTtl(t.ttlSeconds))} · RCA sent: ${t.rcaSent ? "yes" : "no"}` +
      `${t.skills.length ? ` · skills carried: ${t.skills.map((s) => `<code>${esc(s)}</code>`).join(" ")}` : ""}` +
      `${incidentId !== null ? ` · <a href="/incidents/${esc(incidentId)}">incident #${esc(incidentId)}</a>` : ""}</p>
     <p class="meta">The window the model reads on this thread's next turn, in order. The first message is pinned — trimming never drops it. Tool results show their size and first line only; the full run is in <a href="/api/trace/${esc(t.threadId)}">the trace</a>.</p>
     ${section(ICON.chats, "Conversation window")}
     <ol class="transcript">${turns}</ol>
     </div>`,
    { current: "/memory/threads", openIncidents }
  );
}
