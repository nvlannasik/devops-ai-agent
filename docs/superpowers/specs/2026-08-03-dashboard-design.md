# Design — Incident Dashboard (phase 1)

**Date:** 2026-08-03
**Status:** design agreed. Nothing implemented yet.
**Scope:** `devops-ai-agent` only. No changes to `devops-mcp-server` or `llm-worker`. One additive
migration and one additive optional field on `LLMResponse`.

## 1. Problem

Every surface this agent has is Slack. Slack is right for *one* incident — the thread carries the
alert, the RCA, the approval buttons, and the on-call reply, all in the place people already work.

It is wrong for every question that spans incidents. A thread cannot tell you how many times
`KubernetesContainerOomKiller` fired this month, whether the remediations we executed actually
worked, or what the RCA said for the incident three weeks ago that nobody remembers the date of.
Postgres already holds all of that; nothing reads it back except the agent's own recall.

## 2. Scope

**In:** a read-only incident browser with headline metrics, plus persistence of LLM token usage.

**Deferred, with reasons:**

- **Live ops view** (in-flight investigations, per-backend health, queue depth). Not deferred for
  being less useful — deferred because it needs state that does not exist. In-flight investigations
  live in the semaphore in memory, per-replica, and vanish on restart. This is "build new state,
  then a page", not "build a page".
- **Control surface** (approve/reject from the web). Highest risk in the set. It duplicates the
  approval path, which is the only path in this system that writes to the cluster. Two code paths
  for the most safety-critical decision are two places that can drift.

**Analytics and the incident browser are one build, not two phases.** They read the same three
tables and differ only in `GROUP BY`. Splitting them would be an artificial boundary.

**One piece of phase 2 is pulled forward:** token usage persistence (§5.2). Time-series data cannot
be backfilled. Adding the table later means the cost view launches with an empty history and has to
wait weeks to mean anything. The cost now is one migration and one insert.

## 3. Placement and process model

A second HTTP listener on `DASHBOARD_PORT` (default `3001`) inside the existing agent process,
started from `index.ts` alongside the Slack app and registered with the same shutdown handler.

Module `src/dashboard/`, with **no coupling to `SlackApp`**. In-process was chosen for cost (no new
Deployment, no new image, no second DB Secret), but the module boundary is kept clean so extracting
it into a second entrypoint from the same image stays a cheap move if it ever needs to be.

### 3.1 Authentication: none, deliberately

There is no login. Access control is the network: the dashboard port is not routed by the public
Ingress.

Two consequences are recorded here so they are decisions rather than surprises:

- **A separate port is a network boundary, not an auth boundary.** Whether this is safe depends
  entirely on nothing routing to it. One Ingress rule and every RCA is open with no gate. Inside the
  cluster, absent a NetworkPolicy, any pod in any namespace can reach it.
- **Identity cannot be retrofitted cheaply.** If a control surface is ever added, it needs to know
  *who* — and a network boundary carries no identity. That is a phase-3 problem, and this design
  accepts it in exchange for phase 1 shipping without an OAuth flow.

### 3.2 Its own connection pool

The dashboard gets a dedicated `Pool` with `max: 3`, not the agent's.

This is the isolation that actually matters given the in-process choice. Sharing the pool means one
slow dashboard query can starve `storeIncident` of connections: the investigation finishes and the
result is silently lost. A separate small pool bounds the worst case to "the dashboard is slow".

`IncidentMemory` already takes `Pool | null` — Postgres is optional in this agent. The dashboard
follows the same convention: with no database configured it renders an explanatory page rather than
failing to start.

## 4. Safety rails

These replace process isolation, so they are load-bearing rather than nice-to-have.

- **`statement_timeout = 3s`** on the dashboard pool's connections. Enforced by Postgres, so a
  runaway query dies at the server instead of occupying the shared event loop.
- **Mandatory `LIMIT`** on every query. Page size 50, hard maximum 200.
- **60-second in-memory TTL cache** for the aggregate numbers. Not a speculative optimization — a
  direct consequence of having no auth. A single tab on refresh is otherwise unthrottled load on the
  same event loop that handles alerts.

## 5. Data

### 5.1 Existing tables (read-only)

| Table | Columns used |
|---|---|
| `incidents` | `id, created_at, resolved_at, alertname, namespace, severity, confidence, root_cause, rca, thread_ts, channel` |
| `remediations` | `incident_id, action, params, status, approved_by, result, created_at, executed_at` |
| `incident_feedback` | `incident_id, slack_user, confirmed_root_cause, action_taken, outcome, created_at` |

`incidents.thread_ts` and `incidents.channel` make every row deep-linkable back to its Slack thread
via `https://slack.com/app_redirect?channel=<channel>&message_ts=<thread_ts>`. That redirect form
needs no workspace domain, so it costs no new configuration. The dashboard complements Slack rather
than replacing it: aggregate and search here, discussion stays there.

### 5.2 New table: `llm_usage`

Migration `004_llm_usage.sql`. One row per LLM call:

```sql
CREATE TABLE IF NOT EXISTS llm_usage (
  id                     BIGSERIAL PRIMARY KEY,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  incident_id            BIGINT REFERENCES incidents(id),  -- NULL for conversation-mode calls
  thread_ts              TEXT,
  backend                TEXT,          -- router backend name; NULL for non-router providers
  route                  TEXT,          -- 'light' | 'heavy' | NULL
  model                  TEXT,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_backend ON llm_usage (backend, created_at DESC);
```

Per-call rows rather than per-incident columns, because the router made "which backend costs what"
a real question, and per-incident totals structurally cannot answer it. `incident_id` is nullable:
conversation-mode calls have no incident.

**Wiring:** `LLMResponse` gains an optional `backend?: string` and `route?: "light" | "heavy"`, set
only by `RouterLLMClient` — additive, and the other three clients are untouched. The insert goes
where `agent/index.ts` already computes and logs the per-call usage (currently `index.ts:195`), so
no new accounting is introduced, only persistence of what is already counted.

**`incident_id` is written by a later backfill, not at insert time.** The rows are produced during
the investigation; the incident row only exists after it finishes, when `storeIncident` runs. So
`thread_ts` is the correlation key written at call time, and `storeIncident` follows its own insert
with:

```sql
UPDATE llm_usage SET incident_id = $1 WHERE thread_ts = $2 AND incident_id IS NULL
```

Rows keep `incident_id IS NULL` forever when the investigation produced no stored incident (a
conversation-mode reply, or a failed run) — which is correct, not a gap.

Writes are **best-effort**: a failed usage insert or backfill is logged and swallowed. Losing a cost
data point must never fail an investigation.

## 6. Pages

All routes are `GET` and read-only.

| Route | Content |
|---|---|
| `/` | Five headline numbers, the trend chart, and the 10 most recent incidents |
| `/incidents` | Full list, filtered via query string: `from`, `to`, `alertname`, `namespace`, `severity`, `resolved`, `page` |
| `/incidents/:id` | Full RCA, its remediations (action, status, approver, result, timing), on-call feedback, and the Slack deep link |
| `/healthz` | Liveness probe |

The five numbers:

1. Incidents per week over the last 12 weeks (trend chart)
2. Most recurring alerts — `alertname` + `namespace`, count, last seen
3. Resolution rate — `resolved_at IS NOT NULL` over the window
4. Remediation success rate — `succeeded / (succeeded + failed)`
5. Feedback outcome distribution — `resolved | mitigated | unresolved | unknown`

## 7. Rendering

Server-rendered HTML from TypeScript template literals. No build step, no new dependency, no client
framework. Filters are a plain form submitting query-string parameters. The trend chart is
server-generated inline SVG — roughly forty lines, no chart library.

This suits the content: a list, a detail view, and five numbers is a document, not an application.

**All interpolated values must be HTML-escaped.** `rca` and `root_cause` are LLM output — arbitrary
text that can contain `<script>` — and `alertname` / `namespace` come from Alertmanager labels.
Rendering either raw is cross-site scripting whose source is our own model. One escape helper,
applied at every interpolation point.

## 8. Error handling

The dashboard is explicitly exempt from this repo's "a config mistake must stop the pod" rule. If
the port fails to bind, or no database is configured, the failure is logged at `error` and startup
continues.

The boot-guard rule exists for things that make the agent unable to do its job: a bad LLM config
means the agent is useless, so it should refuse to run. A port conflict on a statistics page means
the agent is fine. Killing the pod over the dashboard would trade handled incidents for unhandled
ones.

Within the dashboard, a failed query renders an error page. It never throws into the process.

## 9. Testing

Pure functions only, matching this repo's existing practice — there is no test-database
infrastructure here, and adding one is out of scope.

- Query-string filters → SQL parameters, including the clamp on page size
- **HTML escaping** (§7) — its own test; this is the security-relevant one
- SVG generation, including the empty and single-point series
- Empty states: no incidents, an incident with no remediations, an incident with no feedback

## 10. Configuration

| Variable | Default | Notes |
|---|---|---|
| `DASHBOARD_ENABLED` | `false` | Off unless asked for; the agent must be unchanged for anyone not using it |
| `DASHBOARD_PORT` | `3001` | Second listener, same process |

The dev overlay sets **only these two environment variables**. It adds no container port and no
Service port, and that is deliberate on two counts. A `containerPort` is documentation rather than
a gate — `kubectl port-forward pod/<name> <local>:3001` reaches a listening process whether or not
the port is declared — so nothing is needed for the intended access path. A Service port would go
further and *widen* in-cluster reach, letting any pod in any namespace hit the dashboard by Service
DNS, on a surface with no authentication (§3.1).

> **Do not "complete" this by adding `containerPorts` or `service.ports` to the dev overlay.**
> `apps/dev/applications/devops-ai-agent/kustomization.yaml` declares `release.yaml` as a
> `patches:` entry, and Kustomize has no schema for a HelmRelease's `spec.values.*`, so those
> lists are replaced wholesale rather than merged. The base carries single-element lists holding
> the agent's port **3000** — adding a 3001 entry to the overlay deletes 3000 from the Service and
> takes down the Ingress path to Slack and `/alert`.

**No Ingress rule** — that absence is the access control (§3.1). `stg` and `prd` stay unset until
someone asks, so enabling it is always a deliberate act.

## 11. Deferred

- Live ops view — needs durable in-flight state first (§2)
- Control surface — needs identity first (§3.1)
- Cost charts over `llm_usage` — the data starts accumulating in phase 1; the view comes later
- NetworkPolicy restricting who may reach the dashboard port
