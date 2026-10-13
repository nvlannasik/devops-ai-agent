# Cross-Alert Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An alert group that hits the same service as an open incident, or a service one call edge away, joins that incident's Slack thread. It gets a "Related alert" post, a child incident row, and one short follow-up, instead of a new thread, investigation and card.

**Architecture:**
- A pure call graph comes from Prometheus `http_client_requests_total{service,peer}`, and a pure `relatedIncident` rule decides the match.
- `SlackApp.handleAlert` checks for a match after the dedup claim and before posting. On a match it posts into the parent thread, stores a child row (migration 013: `subjects`, `parent_id`), and queues a follow-up on the parent's thread queue.
- Every thread-keyed incident lookup and recall query skips child rows.
- Everything fails open to today's path.

**Tech Stack:** TypeScript ESM, Node 24, `node:test` + tsx, Postgres, Slack Bolt.

**Spec:** `devops-ai-agent/docs/superpowers/specs/2026-10-13-alert-correlation-design.md`

## Global Constraints

- **Repo:** only `devops-ai-agent`. `npm test`, `npx tsc --noEmit` and `npm run build` must pass. Push to `main` is authorized.
- **Dependencies:** none new.
- **Fail open:** a graph that cannot be read, a post that fails, or no match all lead to today's path (new thread plus investigation). An alert is never lost to correlation.
- **Match rule:** same namespace; parent unresolved and started at most 30 minutes before the new alert, and not after it; a subject equal, or one call edge apart in either direction. The latest match wins.
- **Parents are top-level only.** A child row is recognised by `parent_id IS NOT NULL` or `rca LIKE 'Merged into%'`; the second covers a child whose parent was still in flight.
- **A child gets no remediation proposal.**
- **Graph query:** `sum by (namespace, service, peer) (rate(http_client_requests_total[1h])) > 0`, with a 3 s timeout and a 5-minute cache on success only.
- **Migration:** the next file is `013_incident_correlation.sql`. Migrations run at pod start, so the file must be idempotent (`IF NOT EXISTS`).
- **Replay:** recorded cases must stay `completed`. Correlation lives in `handleAlert`, before `investigate()`.
- **Docs:** written in English.

## Review Focus

1. **Thread-keyed lookups pick the child.** A child row shares the parent's `thread_ts`, and `findIncidentByThread`, `threadAlertIdentity` and the dashboard's trace→incident join all order `DESC LIMIT 1`, so they would return the CHILD. `learn` feedback would then attach to the wrong incident, and the mention marker would anchor to the wrong alert. Task 2 adds the top-level filter and tests each lookup.
2. **Recall serving "Merged into…" as a prior RCA.** A child's alertname recurring alone would recall its placeholder RCA. Task 2 excludes children from `recall` and `recallSimilar`.
3. **The parent/child race.** The parent row can be stored between the candidate read and the child insert. The child insert resolves its parent by thread, and the parent's store links children, so the link holds in both orders. Tested in Task 2.
4. **A merged alert's resolve closes the right row.** `markResolved` keys on alertname + namespace. The child's alertname differs from the parent's, so each closes its own row. Tested in Task 3.
5. **A Slack failure on the parent post.** The normal path runs, and the dedup claim stays taken. That is correct, because the normal path then investigates. Tested in Task 3.

---

### Task 1: Call graph + relation rule (pure)

**Files:**
- Create: `devops-ai-agent/src/agent/correlation/topology.ts`
- Test: `devops-ai-agent/src/agent/correlation/topology.test.ts`

**Interfaces:**
- Produces:
  - `CALL_GRAPH_QUERY: string`
  - `type CallGraph = Record<string, Array<{ from: string; to: string }>>`
  - `parseCallGraph(promResult: string): CallGraph | null`
  - `serviceGraph(callTool, now?): Promise<CallGraph | null>` (cached 5 min, 3 s timeout) and `resetServiceGraphCache()`
  - `interface OpenIncident { threadTs: string; channel: string; alertname: string; namespace: string; subjects: string[]; startedAt: number; resolved: boolean; id?: number }`
  - `type Relation = { incident: OpenIncident; via: "same-service" | { from: string; to: string } }`
  - `relatedIncident(alert: { namespace: string; subjects: string[]; startsAt: number }, open: OpenIncident[], graph: CallGraph): Relation | null`
  - `describeVia(via: Relation["via"]): string`

- [ ] **Step 1: Write the failing tests**

```ts
// devops-ai-agent/src/agent/correlation/topology.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_GRAPH_QUERY, parseCallGraph, relatedIncident, describeVia, serviceGraph, resetServiceGraphCache, type OpenIncident } from "./topology.js";

const VECTOR = JSON.stringify({
  status: "success",
  data: { resultType: "vector", result: [
    { metric: { namespace: "sample-apps", service: "checkout-gateway", peer: "orders-api" }, value: [1, "0.1"] },
    { metric: { namespace: "sample-apps", service: "storefront", peer: "checkout-gateway" }, value: [1, "0.3"] },
  ] },
});
const G = parseCallGraph(VECTOR)!;
const MIN = 60_000;
const T0 = Date.parse("2026-10-13T10:00:00Z");
const open = (over: Partial<OpenIncident> = {}): OpenIncident => ({ threadTs: "100.1", channel: "C1", alertname: "SampleAppHighLatency", namespace: "sample-apps", subjects: ["orders-api"], startedAt: T0, resolved: false, ...over });
const alert = (subjects: string[], at = T0 + 5 * MIN, namespace = "sample-apps") => ({ namespace, subjects, startsAt: at });

test("parseCallGraph: caller → callee edges per namespace; anything but a vector is null", () => {
  assert.deepEqual(G["sample-apps"], [{ from: "checkout-gateway", to: "orders-api" }, { from: "storefront", to: "checkout-gateway" }]);
  assert.equal(parseCallGraph("Error: prometheus down"), null);
  assert.equal(parseCallGraph(JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })), null);
  assert.equal(parseCallGraph(JSON.stringify({ status: "error" })), null);
});

test("the query names the client-call metric and its service/peer labels", () => {
  assert.match(CALL_GRAPH_QUERY, /http_client_requests_total/);
  assert.match(CALL_GRAPH_QUERY, /by \(namespace, service, peer\)/);
});

test("relatedIncident matches the same service, the alert as caller, and the alert as callee", () => {
  assert.equal(relatedIncident(alert(["orders-api"]), [open()], G)?.via, "same-service");
  assert.deepEqual(relatedIncident(alert(["checkout-gateway"]), [open()], G)?.via, { from: "checkout-gateway", to: "orders-api" });
  assert.deepEqual(relatedIncident(alert(["orders-api"]), [open({ subjects: ["checkout-gateway"] })], G)?.via, { from: "checkout-gateway", to: "orders-api" });
});

test("relatedIncident refuses 2 hops, another namespace, >30 min, a later parent, resolved, and no subjects", () => {
  assert.equal(relatedIncident(alert(["storefront"]), [open()], G), null, "storefront → gateway → orders is two hops");
  assert.equal(relatedIncident(alert(["orders-api"], T0 + 5 * MIN, "other"), [open()], G), null);
  assert.equal(relatedIncident(alert(["orders-api"], T0 + 31 * MIN), [open()], G), null);
  assert.equal(relatedIncident(alert(["orders-api"], T0 - MIN), [open()], G), null, "a parent that started after the alert");
  assert.equal(relatedIncident(alert(["orders-api"]), [open({ resolved: true })], G), null);
  assert.equal(relatedIncident(alert([]), [open()], G), null);
});

test("relatedIncident: the latest matching parent wins", () => {
  const r = relatedIncident(alert(["orders-api"]), [open({ threadTs: "old", startedAt: T0 - 10 * MIN }), open({ threadTs: "new", startedAt: T0 })], G);
  assert.equal(r?.incident.threadTs, "new");
});

test("describeVia", () => {
  assert.equal(describeVia("same-service"), "same service");
  assert.equal(describeVia({ from: "a", to: "b" }), "a → b");
});

test("serviceGraph caches a good graph for 5 minutes and never caches a failure", async () => {
  resetServiceGraphCache();
  let calls = 0;
  let fail = true;
  const callTool = async () => { calls++; if (fail) throw new Error("timeout"); return VECTOR; };
  assert.equal(await serviceGraph(callTool, () => T0), null);
  fail = false;
  assert.ok(await serviceGraph(callTool, () => T0));
  await serviceGraph(callTool, () => T0 + 4 * MIN);
  assert.equal(calls, 2, "cached inside 5 min");
  await serviceGraph(callTool, () => T0 + 6 * MIN);
  assert.equal(calls, 3, "expired after 5 min");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/agent/correlation/topology.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// devops-ai-agent/src/agent/correlation/topology.ts
import logger from "../../utils/logger/index.js";

// Cross-group correlation by the LIVE call graph (spec 2026-10-13-alert-correlation-design).
// One fault fires several alert groups — orders-api slows, checkout-gateway (its caller) alerts
// on errors, storefront on latency — and each used to get its own thread, investigation and card.
// Edges come from traffic, never from names: `http_client_requests_total{service,peer}` is the
// sample apps' client-metric contract (devops-sample-apps/packages/platform/src/metrics.ts).
// Fail open: no graph means no correlation, which is today's behaviour.

export const CALL_GRAPH_QUERY = "sum by (namespace, service, peer) (rate(http_client_requests_total[1h])) > 0";
export type CallGraph = Record<string, Array<{ from: string; to: string }>>;
export interface OpenIncident { threadTs: string; channel: string; alertname: string; namespace: string; subjects: string[]; startedAt: number; resolved: boolean; id?: number }
export type Relation = { incident: OpenIncident; via: "same-service" | { from: string; to: string } };

const WINDOW_MS = 30 * 60_000;
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;

export function parseCallGraph(promResult: string): CallGraph | null {
  let p: { status?: string; data?: { resultType?: string; result?: Array<{ metric?: Record<string, string> }> } };
  try { p = JSON.parse(promResult); } catch { return null; }
  if (p.status !== "success" || p.data?.resultType !== "vector" || !Array.isArray(p.data.result)) return null;
  const g: CallGraph = {};
  for (const s of p.data.result) {
    const { namespace, service, peer } = s.metric ?? {};
    if (!namespace || !service || !peer || service === peer) continue;
    (g[namespace] ??= []).push({ from: service, to: peer });
  }
  return g;
}

let cached: { at: number; graph: CallGraph } | null = null;
export const resetServiceGraphCache = (): void => { cached = null; };

export async function serviceGraph(
  callTool: (name: string, input: Record<string, unknown>) => Promise<string>,
  now: () => number = Date.now
): Promise<CallGraph | null> {
  if (cached && now() - cached.at < CACHE_MS) return cached.graph;
  try {
    const raw = await Promise.race([
      callTool("prometheus_query", { query: CALL_GRAPH_QUERY }),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref?.(); }),
    ]);
    const graph = parseCallGraph(raw);
    if (!graph) { logger.info(`[correlation] graph unavailable: not a vector (${raw.slice(0, 120)})`); return null; }
    cached = { at: now(), graph };
    return graph;
  } catch (err) {
    logger.info(`[correlation] graph unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function relatedIncident(alert: { namespace: string; subjects: string[]; startsAt: number }, open: OpenIncident[], graph: CallGraph): Relation | null {
  if (alert.subjects.length === 0) return null;
  const edges = graph[alert.namespace] ?? [];
  const viaFor = (c: OpenIncident): Relation["via"] | null => {
    for (const a of alert.subjects) {
      for (const b of c.subjects) {
        if (a === b) return "same-service";
        const e = edges.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
        if (e) return e;
      }
    }
    return null;
  };
  const matches = open
    .filter((c) => c.namespace === alert.namespace && !c.resolved && c.startedAt <= alert.startsAt && alert.startsAt - c.startedAt <= WINDOW_MS)
    .map((c) => ({ incident: c, via: viaFor(c) }))
    .filter((m): m is Relation => m.via !== null)
    .sort((x, y) => y.incident.startedAt - x.incident.startedAt);
  return matches[0] ?? null;
}

export const describeVia = (via: Relation["via"]): string => (via === "same-service" ? "same service" : `${via.from} → ${via.to}`);
```
Check the logger import path against other `src/agent/*` modules. Also add a test pinning `CALL_GRAPH_QUERY`'s metric against the Prometheus metric allowlist that `src/agent/skills/real.test.ts` keeps:
- import or export the allowlist rather than copying it;
- if it cannot be exported without restructuring, assert the metric literally, and say so in the report.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd devops-ai-agent && npx tsx --test src/agent/correlation/topology.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (no push; Task 3 pushes)

```bash
cd devops-ai-agent && git add src/agent/correlation/topology.ts src/agent/correlation/topology.test.ts && git commit -m "feat(correlation): live call graph + one-hop relation rule"
```

---

### Task 2: Migration 013 + IncidentStore (subjects, children, top-level filter)

**Files:**
- Create: `devops-ai-agent/migrations/013_incident_correlation.sql`
- Modify: `devops-ai-agent/src/agent/incidents/index.ts`:
  - `store()` gains `subjects` and child handling, and links children on a parent store;
  - new `openRelatable`;
  - a top-level filter on `recall`, `recallSimilar`, `findIncidentByThread`, `threadAlertIdentity` and `changesForThread`.
- Modify: `devops-ai-agent/src/agent/index.ts` (`storeIncident` passes the options through; new `openRelatable`)
- Modify: `devops-ai-agent/src/dashboard/queries.ts:640` and `:696` (top-level filter on the thread joins)
- Test: `devops-ai-agent/src/agent/incidents/index.test.ts`

**Interfaces:**
- Consumes: `OpenIncident` (Task 1).
- Produces:
  - `IncidentStore.store(labels, rca, slack?, alertSeverity?, changes?, opts?: { subjects?: string[]; child?: boolean })`. For `child: true`, `parent_id` comes from the thread's top-level row when one exists. After any non-child INSERT, that thread's unlinked children are linked.
  - `IncidentStore.openRelatable(namespace: string, sinceMinutes: number): Promise<OpenIncident[]>`.
  - `DevOpsAgent.storeIncident(labels, rca, channel?, threadTs?, alertSeverity?, changes?, opts?)` passes `opts` through.
  - `DevOpsAgent.openRelatable(namespace, sinceMinutes)` delegates.
  - The exported constant `TOP_LEVEL = "parent_id IS NULL AND rca NOT LIKE 'Merged into%'"` in `incidents/index.ts`.

- [ ] **Step 1: Write the failing tests**

Use the fake-pool pattern `incidents/index.test.ts` already uses (it records SQL and params). Tests:
- `store(..., { subjects: ["orders-api"] })` passes `JSON.stringify(["orders-api"])` as a param, and the INSERT column list includes `subjects`.
- `store(..., { child: true })` sends an INSERT whose `parent_id` value is a subquery over the same channel/thread_ts carrying the TOP_LEVEL filter. Assert the SQL text contains `parent_id` and `rca NOT LIKE 'Merged into%'`. A child store never issues the linking UPDATE.
- A non-child `store` that returns an id issues, after the INSERT, `UPDATE incidents SET parent_id = $1 WHERE channel = $2 AND thread_ts = $3 AND id <> $1 AND parent_id IS NULL AND rca LIKE 'Merged into%'`.
- `openRelatable("sample-apps", 30)` sends SQL containing `resolved_at IS NULL`, the TOP_LEVEL filter and `namespace = $1`. It maps rows to `OpenIncident`: `startedAt = Date.parse(created_at)` (or `.getTime()` on a Date), `subjects` from jsonb (`[]` when null), `resolved: false`.
- `findIncidentByThread`, `threadAlertIdentity`, `recall`'s hypothesis query and `recallSimilar`'s candidate CTE contain the TOP_LEVEL filter (on SQL text; the CTE uses the `i.` alias).
- The migration file contains `ADD COLUMN IF NOT EXISTS subjects jsonb` and `ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES incidents(id)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/agent/incidents/index.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`migrations/013_incident_correlation.sql`:
```sql
-- Cross-group correlation (agent/correlation/topology.ts): an alert group that hits the same
-- service as an open incident, or one call edge away, is stored as a CHILD of it — same Slack
-- thread, `parent_id` set, rca "Merged into …". `subjects` is the service-level identity both
-- sides are matched on. Children are never parents and never recalled (TOP_LEVEL filter).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS subjects jsonb;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES incidents(id);
CREATE INDEX IF NOT EXISTS incidents_open_by_namespace ON incidents (namespace, created_at) WHERE resolved_at IS NULL;
```
`incidents/index.ts`:
- `export const TOP_LEVEL = "parent_id IS NULL AND rca NOT LIKE 'Merged into%'";`, with a comment: a child row shares its parent's thread_ts, and an unlinked child (its parent was in flight at merge time) is known by its rca prefix.
- `store(...)`:
  - Add the `subjects` column and value (`opts?.subjects ? JSON.stringify(opts.subjects) : null`), and the `parent_id` column.
  - For `opts?.child`, the `parent_id` value is the subquery `(SELECT id FROM incidents WHERE channel = $X AND thread_ts = $Y AND ${TOP_LEVEL} ORDER BY id LIMIT 1)`, reusing the channel/thread params' real positions. For a non-child it is `NULL`.
  - After a non-child INSERT that returned an id and has channel + thread, run the linking UPDATE in its own try/catch with an error log. Linking is best-effort and never fails the store.
- `openRelatable(namespace, sinceMinutes)`:
  `SELECT id, channel, thread_ts, alertname, namespace, subjects, created_at FROM incidents WHERE namespace = $1 AND resolved_at IS NULL AND ${TOP_LEVEL} AND created_at > now() - ($2::int * interval '1 minute') ORDER BY created_at DESC LIMIT 20`.
  Map to `OpenIncident`, and return `[]` on error with a log.
- Add the TOP_LEVEL filter to:
  - `findIncidentByThread`
  - `threadAlertIdentity`
  - `changesForThread`
  - `recall`'s hypothesis query
  - `recallSimilar`'s `cand` CTE (aliased: `AND i.parent_id IS NULL AND i.rca NOT LIKE 'Merged into%'`)
  - Leave `markResolved` alone: it must close children too.
- `agent/index.ts`: `storeIncident(..., changes?, opts?: { subjects?: string[]; child?: boolean })` passes `opts` as the new last argument of `this.incidents.store`. Add `openRelatable(namespace: string, sinceMinutes: number) { return this.incidents.openRelatable(namespace, sinceMinutes); }`.
- `dashboard/queries.ts:640` (the trace→incident subquery) and `:696` (`WHERE i.thread_ts = $1`): add the TOP_LEVEL filter with each query's alias. Import the constant, or repeat it with a comment pointing back.

- [ ] **Step 4: Run tests, full suite, tsc**

Run: `cd devops-ai-agent && npx tsx --test src/agent/incidents/index.test.ts && npm test > /tmp/claude-1000/agent-test-corr2.log 2>&1; tail -12 /tmp/claude-1000/agent-test-corr2.log; npx tsc --noEmit && echo TSC_OK`
Expected: all pass, replay completed, `TSC_OK`. Existing tests that pin exact SQL text may need the new filter added to their expected strings. Update only those, and list them.

- [ ] **Step 5: Commit** (no push)

```bash
cd devops-ai-agent && git add migrations/013_incident_correlation.sql src/agent/incidents src/agent/index.ts src/dashboard/queries.ts && git commit -m "feat(incidents): subjects + parent_id; children never anchor a thread or a recall"
```

---

### Task 3: Merge in `handleAlert` + follow-up (app wiring)

**Files:**
- Modify: `devops-ai-agent/src/app/index.ts`:
  - the `unstored` value type and its `set` in `handleAlert`;
  - a new private `correlate(...)`;
  - the merge call in `handleAlert`;
  - `storeIncident` in `investigateAlertInBackground` passes `subjects`.
- Modify: `devops-ai-agent/src/agent/index.ts` (a thin public `callTool` if no MCP accessor exists)
- Create: `devops-ai-agent/src/app/correlation.test.ts`

**Interfaces:**
- Consumes: Task 1 (`serviceGraph`, `relatedIncident`, `describeVia`, `OpenIncident`, `resetServiceGraphCache`), and Task 2 (`agent.openRelatable`, `agent.storeIncident(..., opts)`).
- Produces: `SlackApp.correlate(channel, groupLabels, firing, issueText, alertSeverity): Promise<boolean>`. It returns true when the alert was merged and handled, and false to take the normal path.

- [ ] **Step 1: Write the failing tests**

Follow the fake-`this` pattern in `src/app/resolved-early.test.ts`: call `SlackApp.prototype.correlate.call(self, ...)` with a hand-built `self`. Build `self` with:
- `unstored: new Map()`, with one in-flight parent under `"100.1"`: `{ key, channel: "C1", namespace: "sample-apps", subjects: ["orders-api"], startedAt: <5 min before the alert>, alertname: "SampleAppHighLatency" }`;
- `agent` with:
  - the MCP accessor the implementation uses, returning Task 1's VECTOR;
  - `openRelatable: async () => []`;
  - `storeIncident: async (...a) => { stored.push(a); return 9; }`;
  - `investigate: async () => "fits: orders-api latency is the cause"`;
- `app.client.chat.postMessage` that records its messages;
- `threadQueue.run(threadId, fn)` that records `threadId` and awaits `fn`.
Call `resetServiceGraphCache()` before each test.

Tests:
- A related alert (`service: "checkout-gateway"`, namespace `sample-apps`, alertname `SampleAppHighErrorRate`):
  - `correlate` returns true;
  - the first post goes to `thread_ts: "100.1"` with text matching `/Related alert\* — SampleAppHighErrorRate .*checkout-gateway → orders-api/`;
  - no post lacks `thread_ts`;
  - `storeIncident` gets threadTs `"100.1"`, an rca starting `Merged into the incident in this thread`, and opts `{ subjects: ["checkout-gateway"], child: true }`;
  - `threadQueue.run` is called with `"100.1"`, and the follow-up reply is posted to `"100.1"`.
- Graph unavailable (the MCP fake throws): false; nothing posted.
- No match (another namespace): false.
- The parent post throws: false; `storeIncident` is not called.
- No service-level subject on the labels: false, and MCP is never called.
- Review Focus 4: a resolve of the child group through `handleResolvedAlert` (reuse the `resolved-early.test.ts` harness shape) calls `agent.resolveIncident` with the CHILD's labels.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/app/correlation.test.ts`
Expected: FAIL (`correlate` is not a function).

- [ ] **Step 3: Implement**

1. `unstored`'s value type gains `channel?: string; namespace?: string; subjects?: string[]; startedAt?: number; alertname?: string`. In `handleAlert`, the existing `this.unstored.set(threadId, { key: incidentKey(groupLabels) })` also records `{ channel, namespace: groupLabels.namespace, subjects: subjects?.values ?? [], startedAt: changeScope.alertAt.getTime(), alertname: alertName }`.
2. New private method (adapt helper names to what the mention path really uses):
```ts
  // Cross-group correlation (agent/correlation/topology.ts, spec 2026-10-13). True = this alert
  // was merged into an open incident's thread and is fully handled; false = take today's path.
  // Fail open at every step: no subject, no graph, no match, or a failed post all return false,
  // so an alert is never lost to correlation.
  // ponytail: in-flight parents are this process's `unstored` map only — a related alert landing
  // on another replica before the parent's row is stored opens its own thread, as before.
  private async correlate(channel: string, groupLabels: Record<string, string>, firing: AlertItem[], issueText: string, alertSeverity: string | null): Promise<boolean> {
    const namespace = groupLabels.namespace;
    const subjects = distinctSubjects(firing)?.values ?? [];
    if (!namespace || subjects.length === 0) return false;
    const graph = await serviceGraph((n, i) => this.agent.callTool(n, i));
    if (!graph) return false;
    const inFlight: OpenIncident[] = [...this.unstored.entries()]
      .filter(([, u]) => u.namespace && u.startedAt !== undefined)
      .map(([threadTs, u]) => ({ threadTs, channel: u.channel ?? channel, alertname: u.alertname ?? "", namespace: u.namespace!, subjects: u.subjects ?? [], startedAt: u.startedAt!, resolved: !!u.resolved }));
    const stored = await this.agent.openRelatable(namespace, 30).catch(() => [] as OpenIncident[]);
    const seen = new Set(inFlight.map((c) => c.threadTs));
    const startsAt = Math.min(...firing.map((a) => Date.parse(a.startsAt ?? "")).filter(Number.isFinite), Date.now());
    const rel = relatedIncident({ namespace, subjects, startsAt }, [...inFlight, ...stored.filter((s) => !seen.has(s.threadTs))], graph);
    if (!rel) return false;
    const alertName = groupLabels.alertname ?? firing[0]?.labels.alertname ?? "Unknown";
    const via = describeVia(rel.via);
    try {
      await this.app.client.chat.postMessage({
        channel: rel.incident.channel,
        thread_ts: rel.incident.threadTs,
        text: `🔗 *Related alert* — ${alertName} on \`${subjects.join("`, `")}\` (${via}) · grouped into this incident\n\n${issueText}`,
        mrkdwn: true,
      });
    } catch (err) {
      logger.warn(`[correlation] could not post ${alertName} into thread ${rel.incident.threadTs} — taking the normal path: ${errDetail(err)}`);
      return false;
    }
    logger.info(`[correlation] ${alertName} (${subjects.join(",")}) merged into thread ${rel.incident.threadTs} via ${via}`);
    await this.agent
      .storeIncident(groupLabels, `Merged into the incident in this thread (${via}).`, rel.incident.channel, rel.incident.threadTs, alertSeverity, null, { subjects, child: true })
      .catch((e) => logger.error(`[correlation] child incident store failed for ${alertName}: ${errDetail(e)}`));
    const question = `Related alert ${alertName} fired on ${subjects.join(", ")} (${via}) while this incident was open. Does it fit the root cause already found? Check only what you need to say so, and say plainly if it looks like a separate problem.`;
    void this.threadQueue.run(rel.incident.threadTs, async () => {
      try {
        const reply = toMrkdwn(await withRoute("light", () => this.agent.investigate(rel.incident.threadTs, question, { mode: "conversation", ...mentionBudget(question, { mention: config.mentionToolRounds, tour: config.tourToolRounds }) })));
        for (const part of splitForSlack(reply)) await this.app.client.chat.postMessage({ channel: rel.incident.channel, thread_ts: rel.incident.threadTs, text: part, mrkdwn: true });
      } catch (err) {
        logger.error(`[correlation] follow-up for ${alertName} in thread ${rel.incident.threadTs} failed: ${errDetail(err)}`);
      }
    });
    return true;
  }
```
   - **MCP accessor:** if `DevOpsAgent` has no public MCP call accessor, add `callTool(name: string, input: Record<string, unknown>) { return this.mcp.callTool(name, input); }`.
   - **Mention path:** mirror how it builds the budget and route and posts a reply (`toMrkdwn`, `splitForSlack`, and `dropCardPromises` if it applies it). If the real shapes differ from the sketch, follow the mention path and say so.
   - **Follow-up mode:** `investigate` already uses the `[FOLLOW-UP]` marker once the thread's RCA is marked sent. Because the follow-up runs on the parent's queue after the parent's investigation, it is a follow-up by construction.
3. In `handleAlert`, right after the dedup claim and the `alertSeverity`/`issueText` lines, and before the alert is posted:
```ts
    if (await this.correlate(channel, groupLabels, firing, issueText, alertSeverity).catch((e) => { logger.warn(`[correlation] failed, taking the normal path: ${errDetail(e)}`); return false; })) return;
```
4. `investigateAlertInBackground`'s `storeIncident(labels, rca, channel, threadId, alertSeverity, changes)` gains `{ subjects: <service-level subjects> }`. Thread the service-level values (from `distinctSubjects`, never pod names) in, e.g. as a new `serviceSubjects: string[]` on `changeScope` built in `handleAlert`.
5. Imports: `serviceGraph`, `relatedIncident`, `describeVia` and `type OpenIncident` from `../agent/correlation/topology.js`, plus whatever the mention path's helpers need.

- [ ] **Step 4: Run tests, full suite, tsc, build; commit and push**

Run: `cd devops-ai-agent && npx tsx --test src/app/correlation.test.ts src/app/resolved-early.test.ts && npm test > /tmp/claude-1000/agent-test-corr3.log 2>&1; tail -12 /tmp/claude-1000/agent-test-corr3.log; npx tsc --noEmit && npm run build 2>&1 | tail -2`
Expected: all green, replay completed, build clean.
```bash
cd devops-ai-agent && git add src/app src/agent/index.ts && git commit -m "feat(correlation): a related alert joins the open incident's thread" && git pull --rebase --autostash origin main && git push origin main
```

---

### Task 4: Dashboard + docs

**Files:**
- Modify: `devops-ai-agent/src/dashboard/queries.ts` (the detail query adds `parent_id`; new `children(parentId)`), `src/dashboard/views.ts` (the "Related alerts" section and the "Merged into #N" line), `src/dashboard/server.ts` (if the detail route assembles the data)
- Test: `devops-ai-agent/src/dashboard/views.test.ts`
- Modify: `devops-ai-agent/CLAUDE.md`, `README.md`, `src/agent/correlation/index.ts` (header comment)

- [ ] **Step 1: Load the dashboard skill and write the failing view tests**

Invoke `ui-ux-pro-max:ui-ux-pro-max` and read `src/dashboard/CLAUDE.md`. Tests:
- `detailPage` with `children: [{ id: 9, alertname: "SampleAppHighErrorRate", subjects: ["checkout-gateway"], created_at, resolved_at: null }]` renders "Related alerts", a link to `/incidents/9`, and the escaped alertname. With no children, there is no section.
- `detailPage` for an incident with `parent_id: 5` renders "Merged into #5" linking to `/incidents/5`.

- [ ] **Step 2: Run them to verify they fail, implement, run them to pass**

- Query: `children(parentId)` is `SELECT id, alertname, subjects, created_at, resolved_at FROM incidents WHERE parent_id = $1 ORDER BY created_at`. The detail query adds `parent_id`.
- View: reuse the existing table helpers, use an icon whose meaning is not already on the page (per `src/dashboard/CLAUDE.md`), and escape everything.
- Check the page in a browser (Playwright in `~/.render-check`, phone width and dark mode) with one child and one parent fixture. Look at the screenshots, and delete the tmp files.

- [ ] **Step 3: Docs**

- `CLAUDE.md`, new gotcha bullet: "**Alert groups correlate across webhooks by the LIVE call graph, and fail open** (`agent/correlation/topology.ts`, spec `docs/superpowers/specs/2026-10-13-alert-correlation-design.md`). A group whose service is the same as, or one `http_client_requests_total{service,peer}` edge from, an unresolved incident's in the same namespace that started ≤30 min earlier posts `🔗 Related alert` into that thread, is stored as a child (`parent_id`, rca `Merged into…`), gets one follow-up and NO card. Children never anchor a thread lookup or a recall (`TOP_LEVEL` in `incidents/index.ts`): a child shares its parent's `thread_ts`, and `ORDER BY id DESC` would otherwise pick it. Any failure (no graph, no subject, a failed post) takes today's path. Known limit: an in-flight parent is visible only to its own replica." The migrations line: next is `014_*.sql`.
- `README.md`: a Key Features row; migrations list gains `013`; next is `014`.
- `src/agent/correlation/index.ts` header: "We deliberately do NOT correlate across different alertnames/webhooks here" gains ": that is `topology.ts`, by the live call graph, never by names".

- [ ] **Step 4: Full suite, build, commit, push**

Run: `cd devops-ai-agent && npm test > /tmp/claude-1000/agent-test-corr4.log 2>&1; tail -8 /tmp/claude-1000/agent-test-corr4.log && npm run build 2>&1 | tail -2`
```bash
cd devops-ai-agent && git add src/dashboard CLAUDE.md README.md src/agent/correlation/index.ts && git commit -m "feat(dashboard): related alerts on the incident page; correlation docs" && git pull --rebase --autostash origin main && git push origin main
```

---

### Task 5: Deploy and verify live

- [ ] **Step 1:** Wait for the agent's "Build & Push Docker Images" run for the pushed sha. Then `kubectl -n devops-tools rollout restart deploy/devops-ai-agent` and `rollout status`. Verify `printenv GIT_SHA` and that the log shows migration 013 applied with 0 errors.
- [ ] **Step 2:** Confirm the graph query live. Port-forward the mcp-server and call `prometheus_query` with `CALL_GRAPH_QUERY`; expect the two sample-apps edges.
- [ ] **Step 3:** Ask the user to trigger two faults minutes apart from the loadgen page (checkout-gateway, then orders-api). Read the agent log for `[correlation] … merged into thread …`, and confirm one thread holds the RCA, the Related alert post and the follow-up. Never trigger faults yourself.
- [ ] **Step 4:** Report in Indonesian, leading with the push range.
