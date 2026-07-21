# DevOps AI Agent

AI-powered DevOps agent for incident investigation and Root Cause Analysis (RCA), integrated with Slack and backed by Kubernetes, Prometheus, and Loki via MCP.

## How It Works

```
Slack mention / Alertmanager webhook
        ↓
   Alert deduplication (fingerprint + 12h TTL; Redis-backed = atomic across pods)
        ↓
   Agent investigates (agentic loop, max 10 iterations, parallel tool calls)
        ↓
   LLM calls MCP tools (K8s, Prometheus, Loki)
        ↓
   RCA posted as Slack Block Kit
        ↓
   Confidence Low? → mention on-call users
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

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build, so `dist/` stays clean. Current coverage: history trimming with `tool_use`/`tool_result` pairing, tool-result truncation (head+tail), conversation memory, the SQS response-release backoff, incident-memory parsing/no-op guards, migrations, alert dedup, investigation-intent detection, namespace scope lock, and the fence-safe Slack splitter.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `SLACK_BOT_TOKEN` | `xoxb-...` | required |
| `SLACK_SIGNING_SECRET` | For HTTP mode | required |
| `SLACK_APP_TOKEN` | `xapp-...` for Socket Mode | optional |
| `SLACK_ALERT_CHANNEL` | Channel ID for Alertmanager alerts | optional |
| `SLACK_ONCALL_USERS` | Comma-separated user IDs, mentioned on Low confidence | optional |
| `SLACK_APPROVER_USERS` | User IDs allowed to approve/reject remediations (falls back to `SLACK_ONCALL_USERS`; both empty = anyone, with a log warning) | optional |
| `LLM_PROVIDER` | `claude` / `openai-compatible` / `private-llm` | `claude` |
| `ANTHROPIC_API_KEY` | Required if claude | — |
| `CLAUDE_MODEL` | | `claude-opus-4-8` |
| `MAX_TOKENS` | Output token ceiling (claude + openai-compatible) | `8096` |
| `OPENAI_COMPATIBLE_BASE_URL` | Required if openai-compatible | — |
| `OPENAI_COMPATIBLE_API_KEY` | | — |
| `OPENAI_COMPATIBLE_MODEL` | | `gpt-4` |
| `SQS_REGION` | Required if private-llm | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | | `llm-response.fifo` |
| `SQS_LLM_TIMEOUT_SECONDS` | Max wait for LLM response — must cover a slow reasoning-model call plus the worker's one 2× retry | `240` |
| `SQS_POLL_WAIT_SECONDS` | | `10` |
| `AWS_ACCESS_KEY_ID` | Local dev only — use IRSA on EKS | — |
| `MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
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
| `REDIS_PASSWORD` | | — |
| `REDIS_TLS` | | `false` |
| `MAX_CONCURRENT_INVESTIGATIONS` | | `5` |
| `MENTION_TOOL_ROUNDS` | Tool-call rounds for plain mentions (each round batches parallel calls); explicit investigation requests & alerts are uncapped. Budget resets per message | `2` |
| `INVESTIGATION_TIMEOUT_SECONDS` | Wall-clock budget per investigation (bounds how long a slot is held) | `300` |
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
| `k8s_scale` | under-capacity (load, HPA at max) | `MAX_SCALE_DELTA` bound, scale-to-zero refused |

All support deployment/statefulset/daemonset (except `k8s_scale`: no daemonset). Flow:

```
RCA posted → agent proposes (separate LLM call, whitelist-validated)
          → mandatory server-side dry-run (bad target / blocked namespace = no card)
          → approval card in the thread:  [ ✅ Approve ]  [ 🚫 Reject ]
          → approver clicks Approve → atomic claim (double-click/multi-pod safe)
          → execute → card updated ✅/❌ → full audit trail in the `remediations` table
          → 90s later: pod-status check posted into the thread (did the rollout converge?)
```

**Nothing ever executes without a human click.** Cards expire after 15 minutes (checked at
click time). Approvers = `SLACK_APPROVER_USERS` (fallback `SLACK_ONCALL_USERS`) — the card
@-mentions them so they get notified.
Requires **Interactivity enabled** on the Slack app (works over Socket Mode — no public URL).

**Recurrence shortcut:** when incident memory holds a CONFIRMED prior for the same alert
and fresh evidence matches, the agent may reply concisely ("known recurrence + confirmed
fix") instead of the full RCA card — incident store and the remediation proposal still run.

> ⚠️ **GitOps guard:** the spec-mutating actions (`set_image`/`set_resources`/`scale`)
> are **refused** on Flux- or Helm-managed workloads (detected via ownership labels) —
> a direct patch would be reverted by the next reconcile / lost on the next `helm
> upgrade`, so no card is posted and the error names where the real fix lives.
> `rollout_restart` stays allowed (GitOps-safe). See `docs/DESIGN_guarded_remediation.md`
> §10 for the planned PR-based flow for Flux-managed workloads.

### Alertmanager Integration

```yaml
receivers:
  - name: devops-ai-agent
    webhook_configs:
      - url: http://your-agent:3000/alert
        send_resolved: true   # enables the resolved-alert loop (✅ thread update + dedup release)
route:
  group_by: ["alertname", "namespace"]
  repeat_interval: 12h
  receiver: devops-ai-agent
```

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

See [llm-worker](../llm-worker) for the worker service deployed in the private network.

## Incident Memory

Set `DB_HOST` (+ `DB_NAME`/`DB_USERNAME`/`DB_PASSWORD`/`DB_SSL_MODE`) to give the agent a durable memory of past incidents (distinct from conversation memory, which is a short-lived Redis/in-memory cache). On each Alertmanager-triggered investigation the agent:

1. **Recalls** prior resolved incidents with the same `alertname` (+ `namespace` if present) and injects a compact digest — *"2026-06-19 (critical, High): OOMKilled — connection pool leak"* — into the prompt.
2. **Stores** the resulting RCA (alertname, namespace, severity, confidence, root cause) after it's posted.

Past incidents are framed to the model as **hypotheses to verify**, not facts, to avoid anchoring on a stale root cause. Recall keys on exact label match (no vector search) — deploy a Postgres component alongside the agent.

**Two trust tiers** (never flattened): agent RCAs are the *hypothesis* tier; `@agent learn` captures the **human-confirmed** tier (`incident_feedback` table — root cause, action taken, outcome, with provenance). On recall, confirmed knowledge is injected first as a *strong prior* ("check this hypothesis FIRST"), hypotheses stay "verify before reuse". Feedback is idempotent per trigger (unique `(incident_id, trigger_key)`), so a double-click or multi-pod delivery can't store twice.

### Database Migrations

Schema lives in versioned `.sql` files under `migrations/` and is applied by a small framework-free runner (`src/db/migrate.ts`):

```bash
npm run migrate          # dev (tsx)
npm run migrate:prod     # prod (node dist/src/db/migrate-cli.js)
```

The runner tracks applied versions in a `schema_migrations` table and wraps each file in a transaction. It takes a **Postgres advisory lock**, so multiple agent pods starting at once (autoscaling) serialize instead of racing on DDL. The agent also runs migrations on startup, so a separate step is optional — but for a clean rollout you can run it as a Kubernetes `Job` or `initContainer` (`command: ["node","dist/src/db/migrate-cli.js"]`) before the Deployment. Add a new change as `migrations/002_*.sql`.

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

## Key Features

| Feature | Details |
|---------|---------|
| Alert Deduplication | Same alert processed once per 12h. With `MEMORY_BACKEND=redis` the claim is an atomic `SET NX` in Redis, so under multi-pod autoscaling only one pod investigates; in-memory fallback is single-pod only |
| Readiness `/health` | Returns `503` (not `200`) when a configured dependency (MCP, Postgres, Redis) is unreachable, so K8s readiness probes stop routing to a pod that can't investigate |
| Incident Memory | Durable (Postgres) — recalls prior RCAs for the same alert+namespace so recurring incidents aren't re-diagnosed from scratch. Disabled unless `DB_HOST` is set |
| On-call Feedback Learning | `@agent learn` in an alert thread extracts the human-confirmed root cause/action/outcome into a trusted tier, recalled as a strong prior on future similar incidents |
| Guarded Remediation | Approval-gated restart / set-image / set-resources / scale after an RCA: whitelist + mandatory dry-run + Slack Approve/Reject buttons + atomic claim + audit trail. Off unless the MCP server enables write tools |
| MCP Reconnect | Exponential backoff + mutex-protected |
| Context Window | Tool results truncated to 8000 chars, history to 40 messages |
| Confidence Threshold | Low → auto-mention `SLACK_ONCALL_USERS` |
| Follow-up Mode | `markRcaSent` flag prevents RCA format on follow-ups |
| Response-Mode Markers | Every entry point stamps a per-message marker (`[SOURCE: Alertmanager ...]` / `[USER MESSAGE ...]` / `[FOLLOW-UP ...]`) — alerts always investigate, plain mentions stay conversational |
| Conversation Guards | Deterministic, for plain mentions: tool budget (`MENTION_TOOL_ROUNDS`), namespace scope lock (first tool round fixes the scope), log fan-out guard (>2 pods → ask instead of dump), RCA-format backstop (auto-reformat), fence-safe message splitting |
| Prompt Caching | Anthropic ephemeral cache reduces token cost |
| Parallel Tools | Independent tool calls executed in parallel |
| Async Alert Webhook | `/alert` acks `200` immediately and investigates in the background — no Alertmanager timeout, notifications never wait behind another alert's investigation |
| SQS Dispatcher | Single per-process dispatcher routes shared-queue responses by `requestId`; releases non-owned messages so concurrent investigations don't stall each other |
| Bounded Latency | Per-tool-call, per-investigation, and SQS client request timeouts prevent a hung dependency from freezing the agent |
| Multi-LLM | Claude, OpenAI-compatible, or private via SQS |
| Prompt from Markdown | Edit `prompts/system.md` to update prompt without rebuild |
| Truncated Logs | Long field values shown as `...[truncated N chars]` |

## Project Structure

```
src/
├── agent/
│   ├── index.ts                  # Agentic loop, parallel tool calls
│   ├── confidence/index.ts       # parseConfidence()
│   ├── context/index.ts          # trimHistory(), sanitizeContentBlocks()
│   ├── dedup/index.ts            # AlertDeduplicator
│   ├── llm/
│   │   ├── claude.ts, openai-compatible.ts, sqs.ts
│   │   ├── index.ts              # createLLMClient() factory
│   │   └── types.ts
│   ├── feedback/index.ts         # On-call learning: transcript builder + extraction JSON parser
│   ├── incidents/index.ts        # Durable incident memory (Postgres) — RCAs + confirmed feedback
│   ├── intent/index.ts           # wantsInvestigation() — full vs capped tool budget
│   ├── mcp/client.ts             # Reconnect + mutex + ping
│   ├── remediation/              # Guarded Remediation: proposal parser + row-flip store
│   ├── scope/index.ts            # Namespace scope lock helpers
│   ├── memory/index.ts           # Redis/in-memory + hasRca/markRcaSent
│   └── prompts/system.ts         # Static prompt + time context
├── app/index.ts                  # Slack Bolt + Alertmanager webhook, /health readiness
├── config/index.ts
├── redis.ts                      # Shared Redis singleton (conversation memory + alert dedup)
├── db/                           # pool.ts (DB_* → pg.Pool), migrate.ts (advisory-locked runner), migrate-cli.ts
└── utils/
    ├── logger/index.ts
    └── slack/blocks.ts           # isRcaResponse(), buildRcaBlocks()
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
