# Cross-alert correlation by service topology — design

Date: 2026-10-13. Sub-project 3 of 4 (change timeline → rollback / revert PR → **topology
correlation** → postmortem draft).

## Goal

One Alertmanager webhook is one group (`group_by`, typically alertname+namespace), and
`correlation/` already investigates a group once. But one fault usually fires SEVERAL groups:
`orders-api` slows down, `checkout-gateway` (which calls it) starts timing out and alerts on its
own error rate, and `storefront` alerts on latency. Today that is three Slack threads, three
investigations, three RCAs and possibly three remediation cards, all for one root cause. The
on-call reads the same story three times and has to work out by hand that it is one incident.

A new alert group that is connected to an open incident — the same service, or one call edge
away in the live service graph — now joins that incident's thread instead of opening its own.

Success:
- Two alerts on services joined by a call edge, minutes apart, produce ONE thread: the first
  investigation's RCA, then a `🔗 Related alert` post and a short follow-up answer.
- A related alert never costs an alert: when the graph is unreadable, the parent thread cannot be
  posted to, or nothing matches, the alert is handled exactly as today.
- Resolve, dedup and remediation keep working per alert group.

Out of scope: correlation across namespaces; paths longer than one edge; trace-derived edges
(Jaeger); merging two investigations that are both already running; re-opening a resolved
incident; the mention path.

## Components

### 1. The service call graph — `src/agent/correlation/topology.ts`

- Source: one `prometheus_query` through MCP:
  `sum by (namespace, service, peer) (rate(http_client_requests_total[1h])) > 0`.
  Each sample is an edge `service → peer` (caller → callee) inside `namespace`. The metric and its
  `service`/`peer` labels are the sample apps' client-metric contract
  (`devops-sample-apps/packages/platform/src/metrics.ts`), live today:
  `storefront → checkout-gateway → orders-api` in `sample-apps`.
- The query string is a module constant. A test pins its metric name against the Prometheus metric
  allowlist `src/agent/skills/real.test.ts` already keeps.
- `parseCallGraph(promResult: string): CallGraph | null` (pure). `CallGraph` is, per namespace, a
  list of `{ from, to }` caller → callee edges. Returns null on anything that is not a successful
  instant vector.
- `serviceGraph(callTool)`: one call with a 3 s timeout, cached in-process for 5 minutes on
  success. A failure is not cached; it returns null and logs `[correlation] graph unavailable: <reason>`.

### 2. The relation rule — `relatedIncident(alert, open, graph)` (pure)

Inputs:
- `alert`: `{ namespace, subjects: string[], startsAt: number }`, the new group.
- `open`: `Array<{ threadTs, channel, alertname, namespace, subjects, startedAt: number, resolved: boolean, id?: number }>`.
- `graph`: `CallGraph`.

A candidate matches when ALL hold:
- same `namespace`;
- not `resolved`;
- `startsAt - 30 min <= startedAt <= startsAt`;
- some subject of the alert and some subject of the candidate are **equal**, or there is a graph
  edge between them in that namespace, in **either direction** (one hop).

Among matches, the latest `startedAt` wins. The result is `{ incident, via }`, where `via` is
`"same-service"` or the recorded edge `{ from, to }` (caller → callee) for the post text.

Subjects are the service-level values `distinctSubjects(firing)` already returns
(`correlation/index.ts`: the `service → deployment → workload → app` walk the delegation hint
uses). The graph is service names, so pod names are never used. A group with no subject never
correlates.

### 3. Open incidents

- **In flight** (this process): the existing `SlackApp.unstored` map (threadTs → incident key)
  gains `{ channel, namespace, subjects, startedAt, alertname }`. It is populated where it is
  today, in `handleAlert`, and cleared where it is today, when the incident row is stored.
- **Stored:** `IncidentStore.openRelatable(namespace, sinceMinutes)` returns rows matching
  `resolved_at IS NULL AND parent_id IS NULL AND rca NOT LIKE 'Merged into%' AND created_at > now() - interval`,
  with `id, channel, thread_ts, alertname, namespace, subjects, created_at`. Only top-level
  incidents are parents: a child never collects children.
- **Migration `013_incident_correlation.sql`:**
  - `subjects jsonb`;
  - `parent_id integer REFERENCES incidents(id)`;
  - a partial index on `(namespace, created_at) WHERE resolved_at IS NULL`.
  - `store()` writes `subjects` for every incident.
- `startedAt` is the alert's `startsAt` for an in-flight parent, and `created_at` for a stored one.
  ponytail: a stored row's `created_at` is minutes after its alert fired, which stretches the
  window slightly for stored parents; store the alert start if it matters.

### 4. Merging, in `handleAlert`

After the dedup claim, before the alert is posted:
1. Compute subjects (`distinctSubjects(firing)`). If there are none, take the normal path.
2. `serviceGraph(...)`. If it is null, take the normal path.
3. Candidates are the in-flight entries plus `openRelatable(namespace, 30)`, de-duplicated by
   `threadTs` (in-flight wins).
4. `relatedIncident(...)`. If there is no match, take the normal path.
5. On a match:
   - Post into the parent's thread: `🔗 *Related alert* — <alertname> on \`<subjects>\` (<via>) · grouped into this incident`, then the group alert text (`buildGroupAlertText`). If this post throws, take the normal path; an alert is never lost to correlation.
   - Store a child incident row: same `channel` and `thread_ts` as the parent, `parent_id` = the parent's id (null while the parent is still in flight, see step 6), `rca` = `Merged into the incident in this thread (<via>).`, `subjects`, `group_labels`. A child gets no remediation proposal.
   - Queue ONE follow-up on the parent's `threadQueue`, so it runs after the parent's investigation when that is still in flight. It runs `agent.investigate(parentThread, message, { mode: "conversation", ...mentionBudget(message) })`, where `message` is wrapped in the existing `[FOLLOW-UP ...]` marker (no RCA format): "Related alert <alertname> fired on <subject> (<via>) while this incident was open. Does it fit the root cause already found? Check only what you need to say so, and say plainly if it looks like a separate problem." The reply is posted to the thread.
6. **In-flight parent:** with no row yet, the child's `parent_id` cannot be set at merge time. The
   child is stored with `parent_id` null and the parent's `thread_ts`. When the parent's own row is
   stored (`storeIncident`), one UPDATE sets `parent_id = <parent id>` on rows with the same
   `channel`/`thread_ts`, `id <> parent` and `parent_id IS NULL`. `openRelatable`'s
   `rca NOT LIKE 'Merged into%'` already keeps an unlinked child from being offered as a parent.

### 5. Resolve and dedup

- **Dedup:** the child group's claim is taken as today, so its 12 h repeats are suppressed.
- **Resolve:** a child group's resolve runs through `handleResolvedAlert` as today. `markResolved`
  (alertname + namespace) closes the child row and posts its ✅ into the shared thread under the
  child's alertname. A child's resolve does not change the parent; a parent's resolve closes the
  parent row only.
- **Early resolve:** `closeIfResolvedEarly` and `unstored` keep working for the parent. A child is
  stored at merge time, so it is never "unstored".

### 6. Dashboard

- The incident detail page gets a "Related alerts" section listing the children (alertname,
  subjects, created, resolved), each linking to its page.
- A child's page shows "Merged into #N" with a link to the parent.
- Queries: `children(parentId)`; `IncidentDetail` gains `parent_id`. The incident list is unchanged.

## Error handling

| Condition | Behaviour |
|---|---|
| Prometheus query fails / times out / not a vector | no correlation; normal path; log line |
| Alert has no service-level subject | normal path |
| Posting into the parent thread fails | normal path (new thread + investigation) |
| Child row store fails | the related post stays; logged; that group's resolve finds no row (as today when a store fails) |
| Follow-up fails | the related post stays; logged |
| Parent resolved while the follow-up is queued | the follow-up still runs; nothing reopens |

Fail-open everywhere: the worst outcome of a correlation bug is today's behaviour, never a lost
alert.

## Known limit

Multi-replica: an in-flight parent is visible only to the replica investigating it. A related
alert routed to another replica in the 2–6 minutes before the parent's row is stored opens its
own thread, as today. After the row is stored, every replica sees it. Prod runs one agent
replica. Marked `ponytail:` in code.

## Testing

- **Pure:**
  - `parseCallGraph`: a vector becomes `{from, to}` edges per namespace; a non-vector or error gives null.
  - `relatedIncident`:
    - matches on the same service, the alert as caller, and the alert as callee;
    - no match on 2 hops, another namespace, more than 30 minutes, a candidate started after the alert, resolved, or no subjects;
    - the latest match wins.
- **Wiring** (fake Slack client / MCP / store):
  - a related alert posts into the parent thread, creates no new top-level message, stores a child row, and queues a follow-up on the parent's thread queue;
  - the graph returns null → normal path;
  - the parent post throws → normal path;
  - an in-flight parent links its children when stored.
- **Contract:** the query constant's metric is on the `real.test.ts` allowlist.
- **Migration** applies; `openRelatable` excludes children (linked or not) and resolved rows.
- **Live:** faults on `checkout-gateway` and `orders-api`, triggered from the loadgen page minutes apart, give one thread with a Related alert post and a follow-up.

## Docs

- `devops-ai-agent/CLAUDE.md`: a gotcha bullet. It covers: correlation across groups by the live call graph, fail-open, one hop, 30 minutes, top-level parents only; a child gets no card; the multi-replica limit. The header comment in `correlation/index.ts`, "we deliberately do NOT correlate across different alertnames/webhooks", gains "…except by the live call graph — see topology.ts".
- `README.md`: a Key Features row. Migrations list gains `013`; next is `014`.
