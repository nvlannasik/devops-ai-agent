# DevOps AI Agent

AI-powered DevOps agent for incident investigation and Root Cause Analysis (RCA), integrated with Slack and backed by Kubernetes, Prometheus, Loki, Alertmanager and Jaeger via MCP.

## Live demo

<!--
  Replace the placeholder below with the demo video. GitHub renders an uploaded .mp4 inline:
  drag the file into a comment/PR on github.com, copy the resulting
  https://github.com/user-attachments/assets/... URL and paste it on its own line here.
  A YouTube/Loom link works too, as a thumbnail image wrapped in a link:
  [![Live demo](docs/media/demo-thumbnail.png)](https://youtu.be/<id>)
-->

> 🎬 **Video coming soon** — the recording will be added here.

What the demo walks through:

1. **Alert → RCA.** A fault knob in the sample apps (e.g. `GATEWAY_TIMEOUT_MS=50`) fires an
   Alertmanager alert; the agent opens a Slack thread, investigates over MCP and posts the RCA card.
2. **Approval-gated remediation.** The agent proposes one fix; an approver clicks *Approve*; the
   change is executed (or opened as a GitOps PR for a Flux-managed workload) and verified ~5 min later.
3. **Follow-up and `learn`.** A conversational follow-up in the thread, then `@agent learn` stores
   the human-confirmed cause for the next recurrence.
4. **Cluster tour.** `@agent explain this cluster` — inventory tables built from the cluster itself,
   plus how each workload is deployed.
5. **Dashboard.** The incident page (RCA, remediation verdict, LLM cost), `/harness` (every gate,
   per run) and the `/cluster` map.

## How It Works

```
Slack mention (allowlisted users) / Alertmanager webhook
        ↓
   Correlation (one webhook = one alert group = one investigation, not N pods → N threads)
        ↓
   Alert deduplication (fingerprint + 12h TTL; Redis-backed = atomic across pods)
        ↓
   Recall past incidents (Postgres) — confirmed fixes, prior RCAs, possibly-related leads
        ↓
   Agent investigates (agentic loop, max 10 iterations, parallel tool calls, per-symptom skills)
        ↓
   LLM calls MCP tools (K8s, Prometheus, Loki, Alertmanager, Tracing)
   — identifiers masked before any backend sees the request, restored in the reply
        ↓
   RCA posted as Slack Block Kit  →  Confidence Low? → mention on-call users
        ↓
   Remediation proposed → gate chain → dry-run → approval card → click → execute → verdict checked later
        ↓
   Whole run recorded (agent_events) → /harness on the dashboard, replayable as a regression case
```

## Requirements

- Node.js >= 24
- A running [devops-mcp-server](../devops-mcp-server)
- Slack app with scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:read`

## Setup

```bash
cp .env.example .env
npm install
npm run dev
npm run build && npm start
npm test                       # unit tests
```

## Testing

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build, so `dist/` stays clean. Note the flip side: a signature change that only breaks a test still passes `npm run build`, so run both.

Covered areas, grouped:

- **Agentic loop plumbing** — history trimming with `tool_use`/`tool_result` pairing, tool-result truncation (head+tail), conversation memory, investigation/tour intent detection, namespace scope lock, alert correlation, trace context, every forced-final-answer ceiling.
- **LLM** — backend registry validation (contiguous indices, overlapping routes, missing fields), router failover being up-only, the `max_tokens` → `max_completion_tokens` retry, the SQS response-release backoff, token accounting, identifier masking, per-backend pricing.
- **Memory** — incident-memory parsing and no-op guards, the three recall tiers, migrations.
- **Remediation** — proposal parsing, the `worthProposing` mention gate (including the negated-vocabulary and Indonesian-stem traps), the full gate chain (`refusalFor`), the durable verification verdicts, GitOps overlay-path detection and PR preview.
- **Slack + dashboard** — the fence-safe splitter, RCA and tour tables, remediation cards, route matching, auth cookies, filter/pagination parsing, HTML escaping, the RCA parser, the topology and cluster maps.
- **Replay** — every case under `replay/cases/` plays a recorded production run back through the current gates (see [Benchmark & replay](#benchmark--replay)).

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `SLACK_BOT_TOKEN` | `xoxb-...` | required |
| `SLACK_SIGNING_SECRET` | For HTTP mode | required |
| `SLACK_APP_TOKEN` | `xapp-...` for Socket Mode | optional |
| `SLACK_ALERT_CHANNEL` | Channel ID for Alertmanager alerts | optional |
| `ALERT_WEBHOOK_TOKEN` | Shared secret required on `POST /alert` (`Authorization: Bearer <token>`). Unset = open + a startup warning. Set it on the Alertmanager side via `http_config.authorization.credentials` | — |
| `SLACK_ALLOWED_USERS` | Comma-separated user IDs allowed to mention the agent and ✅-learn (`SLACK_ONCALL_USERS` and `SLACK_APPROVER_USERS` are always admitted too). Anyone else gets an ephemeral "not registered" reply and is logged. Unset = anyone in the channel, with a startup warning. Alerts are unaffected | optional |
| `SLACK_ONCALL_USERS` | Comma-separated user IDs, mentioned on Low confidence | optional |
| `SLACK_APPROVER_USERS` | User IDs allowed to approve/reject remediations (falls back to `SLACK_ONCALL_USERS`; both empty = anyone, with a log warning) | optional |
| `LLM_PROVIDER` | `claude` / `openai-compatible` / `private-llm` / `router` (see [LLM Router](#llm-router)) | `claude` |
| `ANTHROPIC_API_KEY` | Required if claude | — |
| `CLAUDE_MODEL` | | `claude-opus-5-5` |
| `LLM_EFFORT` | Thinking effort on Opus 5.5+ (`low`…`max`). The only dial for how much of `MAX_TOKENS` goes to thinking rather than the answer. Not `CLAUDE_EFFORT` — the Claude Code harness owns that name | model default (`medium`) |
| `MAX_TOKENS` | Output token ceiling (claude + openai-compatible). On Opus 5.5+ this covers thinking **plus** the answer | `8096` |
| `OPENAI_COMPATIBLE_BASE_URL` | Required if openai-compatible | — |
| `OPENAI_COMPATIBLE_API_KEY` | | — |
| `OPENAI_COMPATIBLE_MODEL` | | `gpt-4` |
| `LLM_BACKEND_<N>_*`, `LLM_ROUTE_HEAVY`, `LLM_ROUTE_LIGHT` | Required if router — see [LLM Router](#llm-router) | — |
| `LLM_ROUTER_FAILURE_THRESHOLD` | Consecutive failures before a backend is skipped for a cool-off | `2` |
| `LLM_ROUTER_COOLOFF_SECONDS` | How long a failing backend is skipped | `120` |
| `LLM_BACKEND_<N>_PRICE_INPUT` / `_OUTPUT` / `_CACHE_READ` | USD per million tokens, for the dashboard's cost figures. Unset = "not priced", never `$0` | — |
| `LLM_MASK_IDENTIFIERS` | Mask IPs, emails, AWS ARNs/account ids and hostnames before any backend sees a request (see [Identifier masking](#identifier-masking)). `false` disables | `true` |
| `SQS_REQUEST_QUEUE_NAME` | Required if private-llm | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | | `llm-response.fifo` |
| `SQS_LLM_TIMEOUT_SECONDS` | Max wait for LLM response — must cover a slow reasoning-model call plus the worker's one 2× retry | `240` |
| `SQS_POLL_WAIT_SECONDS` | | `10` |
| `SQS_GITOPS_REQUEST_QUEUE_NAME` | Second request queue — GitOps PR ops to the llm-worker. Shares the LLM response queue, routed by `requestId` | `gitops-request.fifo` |
| `SQS_GITOPS_TIMEOUT_SECONDS` | Max wait for a dry-run / open-PR round-trip | `120` |
| `AWS_REGION` | Region for SQS (all modes) | `ap-southeast-1` |
| `AWS_ACCESS_KEY_ID` | Local dev only — use IRSA on EKS | — |
| `MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
| `MCP_STDIO_COMMAND` | Interpreter for the stdio transport | `node` |
| `MCP_STDIO_ARGS` | Path to MCP server `dist/index.js` | — |
| `MCP_HTTP_URL` | | `http://localhost:3001/mcp` |
| `MCP_AUTH_TOKEN` | Bearer token sent to the MCP server (http transport); must match the server's `MCP_AUTH_TOKEN` | — |
| `MCP_TOOL_TIMEOUT_SECONDS` | Per-tool-call timeout (a hung MCP server can't stall an investigation) | `45` |
| `MEMORY_BACKEND` | Conversation memory: `inmemory` or `redis` | `inmemory` |
| `DB_HOST` | Postgres host for durable incident memory; **disabled if unset** | — |
| `DB_PORT` | | `5432` |
| `DB_NAME` | | `devops_agent` |
| `DB_USERNAME` | | — |
| `DB_PASSWORD` | | — |
| `DB_SSL_MODE` | `disable` / `require` / `verify-full` | `disable` |
| `REDIS_HOST` | | `localhost` |
| `REDIS_PORT` | | `6379` |
| `REDIS_DB` | | `0` |
| `REDIS_USERNAME` | ACL user, if the Redis requires one | — |
| `REDIS_PASSWORD` | | — |
| `REDIS_TLS` | | `false` |
| `MAX_CONCURRENT_INVESTIGATIONS` | | `5` |
| `MENTION_TOOL_ROUNDS` | Tool-call rounds for plain mentions (each round batches parallel calls); explicit investigation requests & alerts are uncapped. Budget resets per message | `2` |
| `TOUR_TOOL_ROUNDS` | Tool-call rounds for a cluster tour ("explain this cluster") — between a plain mention and an uncapped investigation | `4` |
| `INVESTIGATION_TIMEOUT_SECONDS` | Wall-clock budget per investigation (bounds how long a slot is held) | `300` |
| `SUBAGENT_ENABLED` | Let the lead investigation delegate one hypothesis at a time to a sub-agent running the same loop in its own context. Offered only where the tool budget is unlimited (alerts and explicit investigation requests), never on a plain mention. Off means the tool is not registered at all, so off is the unchanged baseline | `false` |
| `SUBAGENT_MAX_FANOUT` | Hypotheses delegated per turn; they run in parallel | `3` |
| `SUBAGENT_TOOL_ROUNDS` | Tool-call rounds a delegate gets. Finite on purpose — a budget is what engages the namespace scope lock and the log fan-out guard | `3` |
| `SUBAGENT_MAX_ITERATIONS` | LLM calls a delegate gets before it must answer from what it has | `5` |
| `REMEDIATION_VERIFY_DELAY_SECONDS` | How long after an approved remediation to check whether it worked. Needs to outlast a rolling update — a half-converged workload reads as "not fixed" | `300` |
| `REMEDIATION_VERIFY_POLL_SECONDS` | How often to look for due verification checks (one indexed query; only bounds how late a verdict lands) | `30` |
| `INCIDENT_RECONCILE_ENABLED` | Close incidents whose alert Alertmanager no longer holds, when the resolved webhook never arrived. Set `false` to disable | `true` |
| `INCIDENT_RECONCILE_MIN_AGE_SECONDS` | How old an incident must be before the sweeper may judge it — Alertmanager's view settles only after `resolve_timeout` + `group_interval` | `600` |
| `INCIDENT_RECONCILE_CONFIRM_SECONDS` | The alert must read as cleared on two passes this far apart before anything closes (one reading also matches an alert flapping through its `for:` window) | `120` |
| `INCIDENT_RECONCILE_BATCH` | Unresolved incidents examined per pass | `50` |
| `GITOPS_REMEDIATION_ENABLED` | Route Flux-managed workloads to a GitOps PR instead of a live write | `false` |
| `DASHBOARD_ENABLED` | Read-only incident dashboard on a second HTTP listener | `false` |
| `DASHBOARD_PORT` | | `3001` |
| `DASHBOARD_PASSWORD` | Single shared password. **Unset ⇒ every page answers `503`**, never anonymous content (`/healthz` stays open). Keep it in a Secret, never a ConfigMap | — |
| `DASHBOARD_COOKIE_SECURE` | Set `false` only for plain-HTTP local dev | `true` |
| `TRACE_ENABLED` | Record every investigation into `agent_events` (needs `DB_HOST`). `false` disables | `true` |
| `GIT_SHA` | Baked in by CI; stamped on every trace so a run can be tied to the build that made it | `unknown` |
| `LOG_LEVEL` | `error\|warn\|info\|http\|debug` | `debug` (dev), `info` (prod) |

## Usage

### Manual Investigation

```
@devops-agent pods in namespace payment-service are crashing with OOMKilled
```

### Follow-up Questions

After RCA is posted, follow-up messages are answered conversationally:

```
@devops-agent show me the logs
@devops-agent when did this start?
```

### Cluster Tour (onboarding)

```
@devops-agent explain this cluster
@devops-agent jelasin namespace sample-apps
```

An explain/overview/onboarding question about the cluster, a namespace or a workload is a
**tour**: its own tool budget (`TOUR_TOOL_ROUNDS`), the `cluster-tour` skill, and no remediation
card. The data is the MCP server's `k8s_cluster_inventory` — one line per workload for the whole
cluster, or the detail of one namespace (Ingress host → Service → workload, plus what manages it:
Flux HelmRelease/Kustomization, Helm, or nothing). In Slack the facts are **tables built from
that tool result, never from the model**, posted before the model's explanation of what each
workload is for and how it is deployed. The dashboard's `/cluster` page shows the same inventory
as a map.

### Teaching the Agent (`learn`)

After an incident is discussed in its alert thread, anyone can teach the agent the
confirmed conclusion:

```
(in the alert thread, after discussing the real cause/fix)
@devops-agent learn
```

The agent extracts `{confirmed root cause, action taken, outcome}` from the thread,
stores it as **human-confirmed** knowledge, and echoes what it learned (mention `learn`
again after correcting the thread if it got it wrong). On the next similar incident the
confirmed knowledge is injected as a strong prior — see Incident Memory below.

Alternatively, react ✅ (`SLACK_LEARN_REACTION`) on any message inside the investigated
thread — same flow, silent outside investigated threads. Needs the `reactions:read`
scope + `reaction_added` event subscription.

### Resolved alerts

When Alertmanager sends `status: resolved` (`send_resolved: true` in the webhook config),
the agent posts "✅ Alert resolved" into the incident thread, records `resolved_at` in the
DB, and releases the dedup claim — so if the alert fires again later it gets a fresh
investigation instead of being suppressed by the 12h dedup TTL.

### Guarded Remediation (approval-gated execution)

When the MCP server has write tools enabled (`MCP_ENABLE_WRITE_TOOLS=true` +
`ALLOWED_REMEDIATION_NAMESPACES` there), the agent may propose **one** remediation after
an RCA (alert-driven or mention-driven). Whitelisted actions:

| Action | When proposed | Extra guardrails |
|--------|---------------|------------------|
| `k8s_rollout_restart` | transient faults a clean restart plausibly fixes | — |
| `k8s_set_image` | RCA shows a wrong/nonexistent image AND evidence names a working one, or the user explicitly requests a tag | never invents tags; `container` optional (auto-resolved when the workload has one container) |
| `k8s_set_resources` | OOMKilled / resource exhaustion | only provided values patched |
| `k8s_scale` | under-capacity (load, HPA at max) | `MAX_SCALE_DELTA` bound; scale-to-zero only as a **quarantine** of a workload a `k8s_recommend_resources` run in the same thread listed as idle |
| `k8s_delete_pod` | ONE pod wedged/crash-looping while siblings are healthy | only controller-owned pods (ReplicaSet/StatefulSet/DaemonSet — the controller recreates it); GitOps-safe |
| `k8s_delete_orphan` | an orphaned object (e.g. a ConfigMap nothing references) found by a scan in the same thread | the manifest is backed up to Postgres and posted into the thread before the delete; the server re-checks provenance/ownership/age live |

All workload actions support deployment/statefulset/daemonset (except `k8s_scale`: no daemonset).

Before a card is posted, the proposal passes one **gate chain** (`refusalFor`, shared with the
benchmark): placeholder and fabricated-evidence checks, asks-for-input, replacement/no-op (e.g. a
restart of a workload whose pods are healthy, an OOM fix that shrinks memory, an image "change" to
the image already running, a restart that cannot fix an RBAC `forbidden`), resource fault,
scale-out, ungrounded target, offer mismatch and duplicate target. A refusal gets one re-ask with
the refusal text; the re-asked proposal runs the chain again. Flow:

```
RCA posted → agent proposes (separate LLM call, whitelist-validated)
          → mandatory server-side dry-run (bad target / blocked namespace = no card)
          → approval card in the thread:  [ ✅ Approve ]  [ 🚫 Reject ]
          → approver clicks Approve → atomic claim (double-click/multi-pod safe)
          → execute → card updated ✅/❌ → full audit trail in the `remediations` table
          → verification scheduled in Postgres (default 5 min later)
          → any replica picks it up → verdict posted into the thread:
            recovered / unchanged / worse / inconclusive — and remembered
```

An alert firing is evidence enough to propose. A **mention** is not, so the proposal call there
runs only when the reply is an RCA, the message asked for a change, or the answer actually
contains fault evidence — otherwise `@agent status check` on a healthy cluster would spend a
heavy LLM call to be told there is nothing to do.

**Nothing ever executes without a human click.** Cards expire after 15 minutes (checked at
click time). Approvers = `SLACK_APPROVER_USERS` (fallback `SLACK_ONCALL_USERS`) — the card
@-mentions them so they get notified.
Requires **Interactivity enabled** on the Slack app (works over Socket Mode — no public URL).

**Recurrence shortcut:** when incident memory holds a CONFIRMED prior for the same alert
and fresh evidence matches, the agent may reply concisely ("known recurrence + confirmed
fix") instead of the full RCA card — incident store and the remediation proposal still run.

> ⚠️ **GitOps guard:** on Flux/Helm-managed workloads a direct spec patch would be reverted
> by the next reconcile, so the spec-mutating actions (`set_image`/`set_resources`/`scale`)
> don't patch directly. `rollout_restart`/`delete_pod` stay allowed (reconcile-safe).
> - **Flux HelmRelease + `GITOPS_REMEDIATION_ENABLED=true`:** the remediation opens a **PR**
>   against the GitOps repo instead (image + scale; the card shows the diff, approve opens
>   the PR, merge applies it). The PR is opened by the **llm-worker** — the private-network
>   bridge to GitHub Enterprise. See `docs/DESIGN_gitops_pr_remediation.md`.
> - **Drift** (the repo declares a value the cluster is not running): the worker refuses the PR
>   and the agent proposes `flux_reconcile` instead — restore what Git declares, still approval-gated.
> - **Otherwise** (flow disabled, Kustomize, or plain Helm): refused with the reason posted
>   to the thread, naming where the real fix lives.

### Alertmanager Integration

```yaml
receivers:
  - name: devops-ai-agent
    webhook_configs:
      - url: http://your-agent:3000/alert
        send_resolved: true   # enables the resolved-alert loop (✅ thread update + dedup release)
        http_config:
          authorization:       # must equal the agent's ALERT_WEBHOOK_TOKEN (omit if unset)
            credentials: <ALERT_WEBHOOK_TOKEN>
route:
  group_by: ["alertname", "namespace"]   # one webhook per group → the agent investigates the group ONCE
  repeat_interval: 12h
  receiver: devops-ai-agent
```

Each webhook the agent receives is one Alertmanager **group** (`group_by`). All alerts in it
share a root cause, so the agent correlates them into **one** thread / investigation /
remediation card — N crashlooping pods no longer spawn N of everything. Correlation across
different alertnames (e.g. a node-down fan-out) is deliberately not attempted.

## RCA Output (Slack Block Kit)

```
🔴 Critical Severity Incident

📍 Root Cause
Pod payment-api-xxx OOMKilled — memory leak in connection pool.

📊 Evidence
• Pod restarted 15x in 30min — k8s_list_events
• Memory 98% of 512Mi limit — prometheus_query
• OutOfMemoryError in logs — loki_query_range

🚫 Ruled Out
• Network issue — no connection errors found

🔧 Recommended Actions
1. Immediate: Increase memory limit to 1Gi
2. Short-term: Review connection pool
3. Long-term: HPA + resource profiling

⚠️ Impact if Unresolved: Payment outage

📈 Confidence: `High`
```

## Private LLM via SQS

For LLMs in a strict private network, set `LLM_PROVIDER=private-llm`. The agent publishes requests to SQS and polls for responses — private network only needs outbound access to AWS SQS.

See [llm-worker](../devops-ai-agent-worker) for the worker service deployed in the private network.

## LLM Router

`LLM_PROVIDER=router` holds several backends at once and picks one per call, so a cheap model
can answer "is anything crashlooping?" while a real investigation gets the strong one.

Backends are declared with indexed env vars — the name is a *value*, so adding one never means
inventing new key names, and `_KEY` can come from a Secret while the rest come from a ConfigMap:

```
LLM_BACKEND_1_NAME=local           LLM_BACKEND_2_NAME=opus
LLM_BACKEND_1_KIND=private-llm     LLM_BACKEND_2_KIND=claude
                                   LLM_BACKEND_2_MODEL=claude-opus-5-5
                                   LLM_BACKEND_2_KEY=sk-ant-...

LLM_ROUTE_LIGHT=local              # optional
LLM_ROUTE_HEAVY=opus               # required; comma-separated = ordered failover chain
```

Two per-backend numbers are worth setting rather than leaving to the global defaults:

- `LLM_BACKEND_<N>_CONTEXT_TOKENS` — the window. The budget takes the **smallest** across all
  backends, because the router picks one *after* the request is built.
- `LLM_BACKEND_<N>_MAX_TOKENS` — the output ceiling. The budget reserves the **largest**,
  because whichever backend answers, its answer has to fit in what is left. Conservative in
  opposite directions, on purpose: an over-reserve shortens the history, an under-reserve
  truncates the answer.

  For `claude` and `openai-compatible` this is sent on the wire, and one global value cannot
  serve both a reasoning model and a fast one — a ceiling that suits the fast model makes the
  reasoning model spend its whole budget thinking and return `stop=max_tokens` with empty
  content. For `private-llm` nothing is sent: llm-worker holds its own `LLM_MAX_TOKENS`, so
  the value here is a **declaration** of that worker's setting, read only to size the reserve.
  Declare it wrong and the backend still behaves the same — the agent just keeps the wrong
  amount of window clear for the reply.

`_KIND` is `claude` / `openai-compatible` / `private-llm`; **only `private-llm` takes the SQS
path**, the others call out directly. Indices must be contiguous from 1, routes may not overlap,
and every route name must exist — all of it validated at boot, so an env typo is a pod that
refuses to start rather than the first alert of the day failing.

**More than one private LLM** is allowed, and then each one names the SQS request queue its own
worker polls:

```
LLM_BACKEND_1_NAME=qwen            LLM_BACKEND_2_NAME=deepseek
LLM_BACKEND_1_KIND=private-llm     LLM_BACKEND_2_KIND=private-llm
LLM_BACKEND_1_REQUEST_QUEUE=llm-request-qwen.fifo
                                   LLM_BACKEND_2_REQUEST_QUEUE=llm-request-deepseek.fifo
```

One queue per **model**, not per replica: replicas of one model share a queue and SQS spreads the
work across them (every request is its own `MessageGroupId`, so FIFO never serialises them). The
*response* queue stays global and shared — replies are routed by `requestId`, never by which model
produced them. With a single `private-llm` the global `SQS_REQUEST_QUEUE_NAME` is enough and
`_REQUEST_QUEUE` can be omitted; with two or more it is required on each, because two backends
quietly sharing one queue makes the route a coin flip and the symptom is an answer from the wrong
model — which reads as a bad answer, not a misconfiguration. Each worker deployment sets its own
`SQS_REQUEST_QUEUE_NAME` to match.

**Light** is used for plain Slack mentions and the RCA-format backstop. Everything else — alerts,
explicit investigation requests, remediation proposals — runs **heavy**. Failover is
**up-only**: a light backend that fails escalates into the heavy chain and stays there for the
rest of that investigation; heavy never falls back to light, because a weak model fails by
answering confidently, not by throwing. Only deterministic failures count (empty response, or
content blocks echoed back as prose — the sign of a dead tool-call channel); judging answer
*quality* would take another LLM call and wouldn't be trustworthy.

Per-call token usage is recorded per backend and route in `llm_usage`. A backend failing
`LLM_ROUTER_FAILURE_THRESHOLD` times in a row is skipped for `LLM_ROUTER_COOLOFF_SECONDS`.

### Cost per investigation

Give each backend its price (USD per million tokens) and the dashboard turns `llm_usage` into
money — per backend on the overview, per investigation on the incident page:

```
LLM_BACKEND_1_PRICE_INPUT=0.05
LLM_BACKEND_1_PRICE_OUTPUT=0.4
LLM_BACKEND_1_PRICE_CACHE_READ=0.005   # optional
```

The prices are the operator's, never a table in code. For `openai-compatible` and `private-llm`
the reported input already contains the cached tokens, so those are billed once at the cache
rate, not twice. A backend with no price reads `not priced`, one that reports no token counts
`not reported` — never `$0`.

## Identifier masking

Before any request leaves the agent — to an external API or the private LLM alike — IPs, emails,
AWS ARNs, AWS account ids (only where the text says it is one) and public hostnames are replaced
with stable tokens (`ip-3f9a1c`, `host-9bfc49`, …). Every token is restored in the reply, text and
tool-call arguments both, so tools, memory, Slack and the dashboard only ever see real values. A
token is a hash of its value, so the same IP is the same token on every call.

Deliberately **not** masked: workload, pod, Service and namespace names (the model reasons with
them), Kubernetes label domains, public image registries, in-cluster DNS, file names and field
paths. The system prompt is never touched (it stays one cached block). Pattern-based: it reduces
what leaves, it is not a guarantee. `LLM_MASK_IDENTIFIERS=false` turns it off.

## Incident Memory

Set `DB_HOST` (+ `DB_NAME`/`DB_USERNAME`/`DB_PASSWORD`/`DB_SSL_MODE`) to give the agent a durable memory of past incidents (distinct from conversation memory, which is a short-lived Redis/in-memory cache). On each Alertmanager-triggered investigation the agent:

1. **Recalls** prior resolved incidents with the same `alertname` (+ `namespace` if present) and injects a compact digest — *"2026-06-19 (critical, High): OOMKilled — connection pool leak"* — into the prompt.
2. **Stores** the resulting RCA (alertname, namespace, severity, confidence, root cause) after it's posted.

Past incidents are framed to the model as **hypotheses to verify**, not facts, to avoid anchoring on a stale root cause — deploy a Postgres component alongside the agent.

**Three trust tiers** (never flattened):

1. **human-confirmed** — `@agent learn` captures root cause, action taken, and outcome with provenance (`incident_feedback`). Injected first as a *strong prior* ("check this hypothesis FIRST"). Feedback is idempotent per trigger (unique `(incident_id, trigger_key)`), so a double-click or multi-pod delivery can't store twice.
2. **agent hypothesis** — the agent's own past RCAs for the exact same `(alertname, namespace)`. "Verify before reuse."
3. **possibly related** — incidents whose recorded root cause merely *shares wording* with the current alert, so a `NodeMemoryPressure` can surface the `OOMKilled` it caused. This is Postgres's built-in full-text search (a generated `tsvector` column + GIN index — no pgvector, no embeddings API, no extension), ranked by how many distinct terms overlap. Weakest tier: a lead to check, never an explanation, and skipped entirely when there is no query text.

Past remediations are recalled too, each carrying the **verdict** of its post-remediation check — so "we already tried this and the alert stayed up" is something the agent can read, not something it has to rediscover.

### Database Migrations

Schema lives in versioned `.sql` files under `migrations/` and is applied by a small framework-free runner (`src/db/migrate.ts`):

```bash
npm run migrate          # dev (tsx)
npm run migrate:prod     # prod (node dist/src/db/migrate-cli.js)
```

The runner tracks applied versions in a `schema_migrations` table and wraps each file in a transaction. It takes a **Postgres advisory lock**, so multiple agent pods starting at once (autoscaling) serialize instead of racing on DDL. The agent also runs migrations on startup, so a separate step is optional — but for a clean rollout you can run it as a Kubernetes `Job` or `initContainer` (`command: ["node","dist/src/db/migrate-cli.js"]`) before the Deployment. Add a new change as the next numbered file (`001`–`012` exist; next is `migrations/013_*.sql`). Because migrations run at pod startup, a migration that fails is a pod that won't start — so avoid anything needing a privilege the app role may not have (`CREATE EXTENSION`, for one).

## Incident Dashboard

Optional read-only web view over the same Postgres the agent writes to. Off by default;
set `DASHBOARD_ENABLED=true` and a `DASHBOARD_PASSWORD`.

```
/                overview — counts, recent incidents, remediation outcomes, model activity + cost per backend
/incidents       filterable list, 10 rows a page
/incidents/N     one incident: the RCA parsed into sections, its remediations & verdicts, LLM usage + cost
/topology        the agent stack's own map: LLM backends, MCP tools, Postgres/Redis/SQS stores
/cluster         the cluster inventory as a map: namespaces, then host → Service → workload → managed by
/harness         every gate's activity across recorded runs, LLM latency per backend
/harness/<gate>  one gate's runs; each links to its full trace
/bench           benchmark history (pass rates per scenario and axis)
/context         what the agent sends the model: skill registry + token budget per backend
/prompt          the system prompt this process is holding
/healthz         open (probe target) — everything else needs the session cookie
```

It runs as a **second HTTP listener in the same process** (`DASHBOARD_PORT`, default `3001`),
separate from Slack's port and deliberately not routed by the Ingress — reach it with
`kubectl port-forward`. Auth is one shared password exchanged for a signed cookie; with
`DASHBOARD_PASSWORD` unset every page answers `503` rather than serving anonymous content.
The listener is the one component allowed to fail without stopping the agent: a bad port or a
missing Secret logs and investigations carry on. Design: [`docs/DESIGN_dashboard_auth.md`](docs/DESIGN_dashboard_auth.md).

Everything rendered is treated as untrusted — the RCA text is LLM output — so every
interpolation is escaped and only the two React Flow maps (`/topology`, `/cluster`) are served
with a `script-src` at all — a per-response nonce, never `'unsafe-inline'`.

## Benchmark & replay

Two ways to measure a change before it ships, both driving the **real** loop:

- **Benchmark** (`npm run bench`, `bench/README.md`) — scenario cases under `bench/cases/`
  (alerts and mentions against a real cluster with the sample apps' fault knobs), scored on RCA,
  proposal and grounding; history appears on `/bench`. Scenarios and scoring:
  [`docs/BENCHMARK_agent_stack.md`](docs/BENCHMARK_agent_stack.md).
- **Replay** (`npm run replay`, [`replay/README.md`](replay/README.md)) — a recorded production run
  played back through the current code. `gates` mode is offline and deterministic and runs under
  `npm test`; `tools` mode re-asks a live model against the recorded tool results.
  `npm run replay:export` turns a run from the dashboard into a redacted case.

## Customizing the System Prompt

The agent's system prompt lives in `prompts/system.md` at the project root — plain Markdown, no TypeScript required.

To update the prompt:
1. Edit `prompts/system.md`
2. Restart the agent (no rebuild needed)

The prompt is read once on first use and cached in memory. Key sections you may want to tune:
- **Response Mode** — conversation vs investigation mode rules
- **Failure Mode Playbooks** — investigation steps per symptom (CrashLoopBackOff, OOMKilled, etc.)
- **RCA Output Format** — Slack Block Kit formatting rules
- **Severity / Confidence thresholds**

#### The query sections are a contract, not examples

The **Loki** and **Prometheus** sections name real labels and real metrics, and they are the one
part of this prompt that can be wrong without anything failing. LogQL answers an unknown *label*
and PromQL answers an unknown *metric* with an **empty result, never an error** — so a wrong name
comes back looking exactly like "there is nothing there", and the agent reports evidence of absence
it never actually gathered. Both have happened here: the prompt shipped `{namespace="X", app="Y"}`
while the log shipper set no `app` label, and `http_requests_total` while the apps expose
`http_server_requests_total`.

So the two lists are pinned by `src/agent/skills/real.test.ts`, as allowlists:

| The prompt may name | Defined by | Kept honest by |
|---|---|---|
| Loki stream labels `namespace`, `app`, `pod`, `container`, `job`, `stream` | fluentbit's `Labels` line + `identity.lua` (GitOps repo) | `the Loki patterns only select on labels fluentbit actually sets` |
| App metrics `http_server_*`, `http_client_*`, `db_*`, `queue_*`, `cache_*`, `build_info` | `packages/platform/src/metrics.ts` in the sample-app repo | `the PromQL patterns only name metrics that exist in this cluster` |

Anything the application logs as a **JSON field** (`service`, `level`, `msg`) is not a label: it
belongs after a `| json` stage and matches nothing inside `{...}`. If you change the log shipper or
re-instrument a service, update the prompt and those allowlists in the same change — nothing else
connects the three repos.

### Skills (`prompts/skills/`)

The system prompt carries what applies to *every* investigation. Anything that applies to
*one symptom* is a skill: a Markdown file with frontmatter (`name`, `description`, `when`)
whose body is injected only when `when` matches the incoming alert or message. `when` is
either `always` or a case-insensitive regex — `crashloop|restarting|restart count`.
`crashloopbackoff.md`, `oomkilled.md`, `pvc-pending.md`, `rca-format.md` and the rest ship in
the repo; drop in another file and restart — no rebuild, no code change.

At most `MAX_MATCHED_SKILLS` (3) skills are injected per turn, each capped at
`SKILL_MAX_CHARS` (8000), ranked by match count. Selection runs again on every tool round —
against the tool *evidence*, not just the alert text, so a generically-named alert picks up the
playbook its first round of output earns (`KubernetesPodNotHealthy` → `imagepullbackoff`) — and a
thread accumulates up to `MAX_THREAD_SKILLS` (5) across rounds, earliest match winning. Under
context-budget pressure skills are dropped before history: history is evidence already gathered,
a skill is advice. Loading is **fail-fast**: a malformed
frontmatter, a duplicate `name`, or an empty skills directory throws at startup rather than
letting the agent run without an RCA output format. The `/context` dashboard page shows what
loaded.

Skills ride in as a separate message, never appended to the system prompt — that keeps the
cached prompt byte-identical across turns, so a per-incident playbook never invalidates the
prompt cache.

## Key Features

| Feature | Details |
|---------|---------|
| Alert Deduplication | Same alert processed once per 12h. With `MEMORY_BACKEND=redis` the claim is an atomic `SET NX` in Redis, so under multi-pod autoscaling only one pod investigates; in-memory fallback is single-pod only |
| Readiness `/health` | Returns `503` (not `200`) when a configured dependency (MCP, Postgres, Redis) is unreachable, so K8s readiness probes stop routing to a pod that can't investigate |
| Incident Memory | Durable (Postgres) — recalls prior RCAs for the same alert+namespace so recurring incidents aren't re-diagnosed from scratch, plus a weaker "possibly related" tier that matches on wording (Postgres full-text search, no extension). Disabled unless `DB_HOST` is set |
| On-call Feedback Learning | `@agent learn` in an alert thread extracts the human-confirmed root cause/action/outcome into a trusted tier, recalled as a strong prior on future similar incidents |
| Guarded Remediation | Approval-gated restart / set-image / set-resources / scale / delete-pod after an RCA: whitelist + mandatory dry-run + Slack Approve/Reject buttons + atomic claim + audit trail. Off unless the MCP server enables write tools. Flux HelmRelease workloads route to a **GitOps PR** (via the llm-worker); the overlay path is auto-detected from the Flux Kustomization. On the mention path the proposal call is skipped unless the answer actually carries fault evidence (or the user asked for a change) — alerts are never gated |
| Post-remediation verification | Durable, not a timer: an executed remediation schedules a check row in Postgres, any replica claims it once due, and the verdict (`recovered` / `unchanged` / `worse` / `inconclusive`) is posted into the same thread and remembered. PR remediations get no check — nothing is live until merge+sync |
| Remediation memory | Past executed remediations (+ their PRs/outcomes and verification verdicts) for the same alert are recalled into future investigations & proposals, so a recurrence's proven fix isn't re-proposed — and a fix that didn't work comes back as a negative prior. All remediations persist in the `remediations` table (change from→to, file, PR URL, status) |
| Incident Dashboard | Optional read-only web view (own listener, own port, shared-password cookie) over the same Postgres — overview, filterable incident list, per-incident RCA + remediation verdicts + LLM cost, the stack's topology, the cluster map, gate activity (`/harness`) and benchmark history |
| Change timeline | Before an alert's investigation, what changed in its namespace in the previous 24h — rollouts with the pod-template diff, HelmRelease upgrades, ConfigMap updates, GitOps commits — goes to the model as data, onto the RCA card as `🕑 Recent changes`, and into the incident row; a source that could not be read says so |
| MCP Reconnect | Exponential backoff + mutex-protected |
| Context Assembly | Every request is assembled, not accumulated: tool results compacted to 8000 chars, conversation history trimmed to 50 messages, then the whole thing fitted to a per-backend token budget (`fitToBudget()`) that drops oldest-first rather than letting the provider reject the call |
| Skills | Per-symptom playbooks in `prompts/skills/*.md`, selected by a `when` regex and injected as a separate message — top 3 per turn, system prompt stays byte-identical so the prompt cache holds |
| Prompt-injection framing | Every string an MCP tool returns is written by something in the cluster — a log line, an event, an annotation — and lands in the conversation beside the operator's question. Text shaped like an instruction to the agent (`ignore previous instructions`, or an imperative naming one of our own tool names) is logged and gets a `[agent guard]` line appended marking the whole result as data. It is never blocked or dropped: the injected string stays quotable as evidence. Not the security boundary — that is still the write-tool filter, the mandatory dry-run and the human approval click |
| Sub-agent delegation | Off by default (`SUBAGENT_ENABLED`), and off means *unregistered* — the tool never reaches the model. When on, an Alertmanager group whose alerts name **two or more different services** is a deterministic trigger: the loop appends a hint asking for one `delegate_investigation` per service, up to `SUBAGENT_MAX_FANOUT` (3) in parallel. A delegate is the same investigation loop with a smaller budget, a deadline inside its parent's, and no delegate tool of its own — it reports a SUPPORTED / CONTRADICTED / UNPROVEN verdict to the lead, never an RCA |
| Confidence Threshold | Low → auto-mention `SLACK_ONCALL_USERS` |
| Follow-up Mode | `markRcaSent` flag prevents RCA format on follow-ups |
| Response-Mode Markers | Every entry point stamps a per-message marker (`[SOURCE: Alertmanager ...]` / `[USER MESSAGE ...]` / `[FOLLOW-UP ...]`) — alerts always investigate, plain mentions stay conversational |
| Conversation Guards | Deterministic, for plain mentions: tool budget (`MENTION_TOOL_ROUNDS`), namespace scope lock (first tool round fixes the scope), log fan-out guard (>2 pods → ask instead of dump), RCA-format backstop (auto-reformat), fence-safe message splitting |
| Prompt Caching | Anthropic ephemeral cache reduces token cost |
| Parallel Tools | Independent tool calls executed in parallel |
| Async Alert Webhook | `/alert` acks `200` immediately and investigates in the background — no Alertmanager timeout, notifications never wait behind another alert's investigation |
| SQS Dispatcher | Single per-process dispatcher routes shared-queue responses by `requestId`; releases non-owned messages so concurrent investigations don't stall each other |
| Bounded Latency | Per-tool-call, per-investigation, and SQS client request timeouts prevent a hung dependency from freezing the agent |
| Multi-LLM | Claude, OpenAI-compatible, or private via SQS — or a router holding several, light/heavy routes, up-only failover |
| Mention allowlist | `SLACK_ALLOWED_USERS` — only registered users can mention the agent or ✅-learn; others get an ephemeral refusal |
| Cluster Tour | Onboarding answers from `k8s_cluster_inventory`: Slack tables built from the tool result (never the model), plus what each workload does and how it is deployed |
| Identifier masking | IPs, emails, ARNs, account ids and public hostnames tokenised before any LLM backend sees a request, restored in the reply |
| Cost per investigation | Operator-supplied per-backend prices turn `llm_usage` into USD on the dashboard |
| Investigation trace + replay | Every run (LLM turns, tool calls, gate decisions) recorded to `agent_events`; replayed offline as regression cases under `npm test` |
| Prompt from Markdown | Edit `prompts/system.md` to update prompt without rebuild |
| Truncated Logs | Long field values shown as `...[truncated N chars]` |

## Project Structure

```
src/
├── agent/
│   ├── index.ts                  # Agentic loop, parallel tool calls
│   ├── confidence/index.ts       # parseConfidence()
│   ├── context/                  # Request assembly — the whole prompt is built per call
│   │   ├── index.ts              # assembleRequest(), injectSkills(), trimToWindow(), sanitizeContentBlocks()
│   │   ├── budget.ts             # estimateTokens(), fitToBudget() — oldest-first drop
│   │   ├── compact.ts            # compactToolResult() — MAX_TOOL_RESULT_CHARS
│   │   └── resolve-budget.ts     # Per-backend context window → Budget
│   ├── skills/                   # index.ts (registry + `when` matching), frontmatter.ts
│   ├── correlation/index.ts      # One webhook = one group = one investigation (not N pods, N threads)
│   ├── dedup/index.ts            # AlertDeduplicator
│   ├── llm/
│   │   ├── claude.ts, openai-compatible.ts, sqs.ts
│   │   ├── registry.ts, router.ts  # LLM_BACKEND_<N>_* parsing; light→heavy up-only failover
│   │   ├── mask.ts               # Identifier masking around every backend
│   │   ├── pricing.ts            # LLM_BACKEND_<N>_PRICE_* → USD
│   │   ├── index.ts              # createLLMClient() factory
│   │   └── types.ts
│   ├── feedback/index.ts         # On-call learning: transcript builder + extraction JSON parser
│   ├── gitops/                   # PR remediation: overlay.ts (path detect), preview.ts, sqs.ts (worker bridge)
│   ├── incidents/index.ts        # Durable incident memory (Postgres) — RCAs + confirmed feedback + similarity tier
│   ├── intent/index.ts           # wantsInvestigation(), wantsTour(), mentionBudget()
│   ├── injection/index.ts        # Prompt-injection framing of tool results
│   ├── trace/                    # Investigation recorder → agent_events (gates, LLM turns, tool calls)
│   ├── mcp/client.ts             # Reconnect + mutex + ping
│   ├── remediation/              # Guarded Remediation
│   │   ├── index.ts              # Proposal parser + row-flip store (atomic claim)
│   │   ├── proposal.ts           # worthProposing(), proposeWithRetry(), the gate chain
│   │   ├── replace-guard.ts, noop-guard.ts  # Healthy-target / RBAC / OOM-shrink / no-op image refusals
│   │   └── verify.ts             # Durable post-remediation check + verdict
│   ├── scope/index.ts            # Namespace scope lock helpers
│   ├── grounding/index.ts        # Resource names asserted but never returned by a tool
│   ├── subagent/index.ts         # Delegate tool, fan-out cap, child deadline/marker (SUBAGENT_ENABLED)
│   ├── memory/index.ts           # Redis/in-memory + hasRca/markRcaSent
│   ├── usage/index.ts            # Per-call token accounting → llm_usage
│   └── prompts/system.ts         # Static prompt + time context
├── app/index.ts                  # Slack Bolt + Alertmanager webhook, /health readiness
├── config/index.ts
├── dashboard/                    # Read-only incident dashboard (own listener, own CSP)
│   ├── server.ts, auth.ts        # Routing + per-route CSP; shared password → signed cookie
│   ├── queries.ts, filters.ts    # Read-only SQL; filter parsing + fixed-size pagination
│   ├── views.ts, html.ts, styles.ts, chart.ts  # Server-rendered pages, esc(), inline SVG charts
│   ├── rca.ts                    # Slack-mrkdwn RCA → per-section cards
│   ├── context.ts                # /context — loaded skills + resolved budget per backend
│   ├── topology.ts, topology-graph.ts  # /topology — the agent stack map
│   ├── cluster-graph.ts          # /cluster — inventory → graph (also bundled for the browser)
│   ├── bench.ts                  # /bench — reads bench/results/history.jsonl
│   └── client/                   # React Flow bundles (topology.js, cluster.js), built by esbuild
├── bench/                        # npm run bench — scenario runner + scoring
├── replay/                       # npm run replay — recorded runs through the current code
├── redis.ts                      # Shared Redis singleton (conversation memory + alert dedup)
├── db/                           # pool.ts (DB_* → pg.Pool), migrate.ts (advisory-locked runner), migrate-cli.ts
└── utils/
    ├── auth/index.ts             # Constant-time secret comparison
    ├── logger/index.ts           # + errDetail()
    ├── trace/index.ts            # withTrace() — threadId as the cross-service traceId
    ├── truncate/index.ts
    └── slack/                    # blocks.ts, rca-tables.ts, tour-tables.ts, remediation-card.ts, split.ts

migrations/    001…011 — run at pod startup, advisory-locked
prompts/       system.md + skills/*.md — editable without a rebuild
bench/         cases/ + results/history.jsonl (committed)
replay/        cases/ — recorded production runs, redacted
docs/          DESIGN_*.md per subsystem, BENCHMARK_agent_stack.md, superpowers/specs (feature designs)
```

## AWS Authentication

Set `AWS_AUTH_MODE` to control how credentials are obtained (read by `entrypoint.sh`):

| `AWS_AUTH_MODE` | Use case | Extra env vars needed |
|-----------------|----------|-----------------------|
| `iam-anywhere` (default) | On-premise / private network with X.509 cert | `AWS_TRUST_ANCHOR_ARN`, `AWS_ROLESANYWHERE_PROFILE_ARN`, `AWS_ROLE_ARN`, `CERT_PATH`, `CERT_KEY_PATH` |
| `irsa` | EKS with IAM Roles for Service Accounts | none |
| `env` | Local dev / CI | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `instance-profile` | EC2 / ECS | none |

## Slack App Setup

1. [api.slack.com/apps](https://api.slack.com/apps) → Create App
2. **OAuth & Permissions** → scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:read`
3. **Event Subscriptions** → subscribe to `app_mention`, `reaction_added`
4. Copy Bot Token + Signing Secret to `.env`
5. Socket Mode: enable + generate App Token with `connections:write`
6. **Interactivity & Shortcuts** → toggle ON (needed for remediation Approve/Reject buttons; over Socket Mode no Request URL is required)

## Docker

```bash
docker build -t devops-ai-agent .

docker run -p 3000:3000 \
  -e SLACK_BOT_TOKEN=xoxb-... \
  -e SLACK_APP_TOKEN=xapp-... \
  -e ANTHROPIC_API_KEY=... \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_URL=http://devops-mcp-server:3000/mcp \
  devops-ai-agent
```
