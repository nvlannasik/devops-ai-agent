import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryListPage, memoryKeyPage, threadsPage, threadPage } from "./memory-views.js";

// /memory (2026-10-20): the agent's memory, read-only — long-term per alert key, short-term per thread.
const key = { alertname: "Kube<Crash>", namespace: "apps", rcas: 3, learned: 1, remediations: 2, recovered: 1, worse: 1, lastSeen: "2026-10-19T00:00:00Z" };
const now = new Date("2026-10-20T00:00:00Z");

test("the key list links each key to its page, escapes it, and names a missing namespace", () => {
  const html = memoryListPage({ rows: [key, { ...key, alertname: "NodeNotReady", namespace: null }], hasMore: false, total: 2 }, { page: 1, alertname: null, namespace: null }, now);
  assert.match(html, /href="\/memory\/alert\?name=Kube%3CCrash%3E&amp;ns=apps"/);
  assert.match(html, /Kube&lt;Crash&gt;/);
  assert.doesNotMatch(html, /Kube<Crash>/);
  assert.match(html, /href="\/memory\/alert\?name=NodeNotReady"/, "no ns parameter is the NULL-namespace key");
  assert.match(html, /no namespace/);
  assert.match(html, /href="\/memory\/threads"/, "the conversation half is one link away");
});

test("an empty key list is the answer, not an error", () => {
  const html = memoryListPage({ rows: [], hasMore: false, total: 0 }, { page: 1, alertname: null, namespace: null }, now);
  assert.match(html, /Nothing remembered yet/);
});

test("a key page shows the exact recall text, escaped, and says what it cannot show", () => {
  const html = memoryKeyPage(
    { alertname: "KubePodCrashLooping", namespace: "apps" },
    { incidents: "HUMAN-CONFIRMED <script>x</script>", remediations: "" },
    { learned: [{ incidentId: 9, slackUser: "U1", confirmedRootCause: "bad env", actionTaken: "rollback", outcome: "resolved", createdAt: "2026-10-18T00:00:00Z" }], rcas: [], remediations: [] },
    now
  );
  assert.match(html, /HUMAN-CONFIRMED &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /possibly related/i, "the tier computed from alert text is named as absent here");
  assert.match(html, /href="\/incidents\/9"/);
  assert.match(html, /No past remediations are recalled/, "an empty recall half is stated");
});

test("the thread list links each thread and its incident, with TTL, RCA flag and skills", () => {
  const html = threadsPage(
    [{ threadId: "1792421141.306329", messages: 12, ttlSeconds: 3960, rcaSent: true, skills: ["cluster-tour"] },
     { threadId: "1700000000.000100", messages: 1, ttlSeconds: null, rcaSent: false, skills: [] }],
    new Map([["1792421141.306329", 42]]),
    now
  );
  assert.match(html, /href="\/memory\/threads\/1792421141\.306329"/);
  assert.match(html, /href="\/incidents\/42"/);
  assert.match(html, /1h 6m/);
  assert.match(html, /cluster-tour/);
});

test("a thread page shows the window in order, pins the issue, and never prints a tool result past its first line", () => {
  const html = threadPage(
    {
      threadId: "1.1", ttlSeconds: 60, rcaSent: false, skills: [],
      messages: [
        { role: "user", content: "why <b>is</b> it down?" },
        { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "t1", name: "k8s_list_configmaps", input: { namespace: "apps" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "first line\nDB_PASSWORD=SECRET-LINE-2" }] },
      ],
    } as never,
    42,
    now
  );
  assert.match(html, /why &lt;b&gt;is&lt;\/b&gt; it down\?/);
  assert.match(html, /pinned/i);
  assert.match(html, /k8s_list_configmaps/);
  assert.match(html, /first line/);
  assert.doesNotMatch(html, /SECRET-LINE-2/, "a tool result is its size and first line only");
  assert.match(html, /href="\/api\/trace\/1\.1"/, "the full record is the trace, one link away");
  assert.match(html, /href="\/incidents\/42"/);
});

test("an expired or unknown thread says so", () => {
  assert.match(threadPage(null, null, now, "9.9"), /expired|no longer/i);
});

// Render check 2026-10-20: `.when` is `white-space: nowrap` (it is for timestamps), and the key and
// thread pages used it on sentences and on tool input — 254–1440px of sideways scroll. Prose here
// takes `.meta`, and a dim code span takes `.mem-dim`, which wraps.
test("no sentence or tool text on the memory pages rides the nowrap timestamp class", () => {
  const key = memoryKeyPage({ alertname: "A", namespace: null }, { incidents: "", remediations: "" }, { learned: [], rcas: [], remediations: [] }, now);
  const thread = threadPage(
    { threadId: "1.1", ttlSeconds: 1, rcaSent: false, skills: [], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: { a: "b" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] }] } as never,
    null, now
  );
  for (const html of [key, thread]) {
    assert.doesNotMatch(html, /<p class="when">/);
    assert.doesNotMatch(html, /<code class="when">/);
  }
});

// Feedback 2026-10-20: the in-page "By alert | Conversations" switch read badly — the two are two
// rail destinations now, and each page (and its detail pages) marks its own.
test("alert memory and conversation memory are two rail destinations, not tabs on one page", () => {
  const current = (html: string) => [...html.matchAll(/<a href="([^"]*)" aria-current="page">/g)].map((m) => m[1]);
  const list = memoryListPage({ rows: [], hasMore: false, total: 0 }, { page: 1, alertname: null, namespace: null }, now);
  const key = memoryKeyPage({ alertname: "A", namespace: null }, null, { learned: [], rcas: [], remediations: [] }, now);
  const threads = threadsPage([], new Map(), now);
  const thread = threadPage(null, null, now, "1.1");
  for (const html of [list, key, threads, thread]) assert.doesNotMatch(html, /aria-label="Memory"/, "no in-page switch");
  assert.deepEqual(current(list), ["/memory"]);
  assert.deepEqual(current(key), ["/memory"]);
  assert.deepEqual(current(threads), ["/memory/threads"]);
  assert.deepEqual(current(thread), ["/memory/threads"]);
  assert.match(list, /<span class="lbl">Alert memory<\/span>/);
  assert.match(list, /<span class="lbl">Conversation memory<\/span>/);
});

test("a thread reads as a transcript: agent, user and tool turns named in words, the first pinned", () => {
  const html = threadPage(
    {
      threadId: "1790000000.000100", ttlSeconds: 60, rcaSent: false, skills: [],
      messages: [
        { role: "user", content: "why is it down" },
        { role: "assistant", content: [{ type: "tool_use", id: "1", name: "k8s_list_pods", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "line one\nline two" }] },
      ],
    } as never,
    null
  );
  assert.match(html, /<li class="turn" data-role="user"><div class="turn-head"><span class="turn-who">user<\/span><span class="meta">#1<\/span><span class="badge"[^>]*>pinned/);
  assert.match(html, /data-role="agent"/);
  assert.match(html, /<span class="turn-who">tool<\/span>/);
  assert.doesNotMatch(html, /line two/);
});

test("the key shelf counts recoveries and names a worse verdict without painting the tile", () => {
  const html = memoryKeyPage({ alertname: "A", namespace: null }, null, {
    learned: [], rcas: [],
    remediations: [
      { incidentId: 1, summary: "s", status: "succeeded", verdict: "recovered", createdAt: new Date().toISOString() },
      { incidentId: 2, summary: "s", status: "succeeded", verdict: "worse", createdAt: new Date().toISOString() },
    ],
  });
  assert.match(html, /<div class="stat"><dt>[\s\S]*?Recovered[\s\S]*?<dd>1<span>of 2 verified · 1 made it worse/);
});
