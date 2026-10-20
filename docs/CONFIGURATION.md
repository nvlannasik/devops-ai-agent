# Configuration

Every setting is an environment variable (`cp .env.example .env` for local dev). Grouped by area;
the defaults are what the agent uses when the variable is unset.

## Slack and the alert webhook

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

## LLM

See [LLM.md](LLM.md) for the router, the private LLM and pricing.

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_PROVIDER` | `claude` / `openai-compatible` / `private-llm` / `router` (see [LLM Router](LLM.md#llm-router)) | `claude` |
| `ANTHROPIC_API_KEY` | Required if claude | — |
| `CLAUDE_MODEL` | | `claude-opus-5-5` |
| `LLM_EFFORT` | Thinking effort on Opus 5.5+ (`low`…`max`). The only dial for how much of `MAX_TOKENS` goes to thinking rather than the answer. Not `CLAUDE_EFFORT` — the Claude Code harness owns that name | model default (`medium`) |
| `MAX_TOKENS` | Output token ceiling (claude + openai-compatible). On Opus 5.5+ this covers thinking **plus** the answer | `8096` |
| `OPENAI_COMPATIBLE_BASE_URL` | Required if openai-compatible | — |
| `OPENAI_COMPATIBLE_API_KEY` | | — |
| `OPENAI_COMPATIBLE_MODEL` | | `gpt-4` |
| `LLM_BACKEND_<N>_*`, `LLM_ROUTE_HEAVY`, `LLM_ROUTE_LIGHT` | Required if router — see [LLM Router](LLM.md#llm-router) | — |
| `LLM_ROUTER_FAILURE_THRESHOLD` | Consecutive failures before a backend is skipped for a cool-off | `2` |
| `LLM_ROUTER_COOLOFF_SECONDS` | How long a failing backend is skipped | `120` |
| `LLM_BACKEND_<N>_PRICE_INPUT` / `_OUTPUT` / `_CACHE_READ` | USD per million tokens, for the dashboard's cost figures. Unset = "not priced", never `$0` | — |
| `LLM_MASK_IDENTIFIERS` | Mask IPs, emails, AWS ARNs/account ids and hostnames before any backend sees a request (see [Identifier masking](LLM.md#identifier-masking)). `false` disables | `true` |

## SQS (private LLM and the GitOps PR flow)

| Variable | Description | Default |
|----------|-------------|---------|
| `SQS_REQUEST_QUEUE_NAME` | Required if private-llm | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | | `llm-response.fifo` |
| `SQS_LLM_TIMEOUT_SECONDS` | Max wait for LLM response — must cover a slow reasoning-model call plus the worker's one 2× retry | `240` |
| `SQS_POLL_WAIT_SECONDS` | | `10` |
| `SQS_GITOPS_REQUEST_QUEUE_NAME` | Second request queue — GitOps PR ops to the llm-worker. Shares the LLM response queue, routed by `requestId` | `gitops-request.fifo` |
| `SQS_GITOPS_TIMEOUT_SECONDS` | Max wait for a dry-run / open-PR round-trip | `120` |
| `AWS_REGION` | Region for SQS (all modes) | `ap-southeast-1` |
| `AWS_ACCESS_KEY_ID` | Local dev only — use IRSA on EKS | — |

## MCP server

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
| `MCP_STDIO_COMMAND` | Interpreter for the stdio transport | `node` |
| `MCP_STDIO_ARGS` | Path to MCP server `dist/index.js` | — |
| `MCP_HTTP_URL` | | `http://localhost:3001/mcp` |
| `MCP_AUTH_TOKEN` | Bearer token sent to the MCP server (http transport); must match the server's `MCP_AUTH_TOKEN` | — |
| `MCP_TOOL_TIMEOUT_SECONDS` | Per-tool-call timeout (a hung MCP server can't stall an investigation) | `45` |

## Storage (conversation memory, incident memory)

See [MEMORY.md](MEMORY.md).

| Variable | Description | Default |
|----------|-------------|---------|
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

## Investigation budgets

See [INVESTIGATION.md](INVESTIGATION.md).

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_CONCURRENT_INVESTIGATIONS` | | `5` |
| `MENTION_TOOL_ROUNDS` | Tool-call rounds for plain mentions (each round batches parallel calls); explicit investigation requests & alerts are uncapped. Budget resets per message | `2` |
| `TOUR_TOOL_ROUNDS` | Tool-call rounds for a cluster tour ("explain this cluster") — between a plain mention and an uncapped investigation | `4` |
| `INVESTIGATION_TIMEOUT_SECONDS` | Wall-clock budget per investigation (bounds how long a slot is held) | `300` |
| `SUBAGENT_ENABLED` | Let the lead investigation delegate one hypothesis at a time to a sub-agent running the same loop in its own context. Offered only where the tool budget is unlimited (alerts and explicit investigation requests), never on a plain mention. Off means the tool is not registered at all, so off is the unchanged baseline | `false` |
| `SUBAGENT_MAX_FANOUT` | Hypotheses delegated per turn; they run in parallel | `3` |
| `SUBAGENT_TOOL_ROUNDS` | Tool-call rounds a delegate gets. Finite on purpose — a budget is what engages the namespace scope lock and the log fan-out guard | `3` |
| `SUBAGENT_MAX_ITERATIONS` | LLM calls a delegate gets before it must answer from what it has | `5` |

## Remediation and incident lifecycle

See [REMEDIATION.md](REMEDIATION.md).

| Variable | Description | Default |
|----------|-------------|---------|
| `REMEDIATION_VERIFY_DELAY_SECONDS` | How long after an approved remediation to check whether it worked. Needs to outlast a rolling update — a half-converged workload reads as "not fixed" | `300` |
| `REMEDIATION_VERIFY_POLL_SECONDS` | How often to look for due verification checks (one indexed query; only bounds how late a verdict lands) | `30` |
| `INCIDENT_RECONCILE_ENABLED` | Close incidents whose alert Alertmanager no longer holds, when the resolved webhook never arrived. Set `false` to disable | `true` |
| `INCIDENT_RECONCILE_MIN_AGE_SECONDS` | How old an incident must be before the sweeper may judge it — Alertmanager's view settles only after `resolve_timeout` + `group_interval` | `600` |
| `INCIDENT_RECONCILE_CONFIRM_SECONDS` | The alert must read as cleared on two passes this far apart before anything closes (one reading also matches an alert flapping through its `for:` window) | `120` |
| `INCIDENT_RECONCILE_BATCH` | Unresolved incidents examined per pass | `50` |
| `GITOPS_REMEDIATION_ENABLED` | Route Flux-managed workloads to a GitOps PR instead of a live write | `false` |

## Dashboard

See [DASHBOARD.md](DASHBOARD.md).

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHBOARD_ENABLED` | Read-only incident dashboard on a second HTTP listener | `false` |
| `DASHBOARD_PORT` | | `3001` |
| `DASHBOARD_PASSWORD` | Single shared password. **Unset ⇒ every page answers `503`**, never anonymous content (`/healthz` stays open). Keep it in a Secret, never a ConfigMap | — |
| `DASHBOARD_COOKIE_SECURE` | Set `false` only for plain-HTTP local dev | `true` |
| `DASHBOARD_PUBLIC_URL` | Base URL of the dashboard, no trailing slash. Not secret — used only to build the `/incidents/<id>/postmortem` link posted into Slack by `@agent postmortem`; unset posts the bare path instead | — |

## Tracing and logs

| Variable | Description | Default |
|----------|-------------|---------|
| `TRACE_ENABLED` | Record every investigation into `agent_events` (needs `DB_HOST`). `false` disables | `true` |
| `GIT_SHA` | Baked in by CI; stamped on every trace so a run can be tied to the build that made it | `unknown` |
| `LOG_LEVEL` | `error\|warn\|info\|http\|debug` | `debug` (dev), `info` (prod) |

## AWS authentication

Set `AWS_AUTH_MODE` to control how credentials are obtained (read by `entrypoint.sh`):

| `AWS_AUTH_MODE` | Use case | Extra env vars needed |
|-----------------|----------|-----------------------|
| `iam-anywhere` (default) | On-premise / private network with X.509 cert | `AWS_TRUST_ANCHOR_ARN`, `AWS_ROLESANYWHERE_PROFILE_ARN`, `AWS_ROLE_ARN`, `CERT_PATH`, `CERT_KEY_PATH` |
| `irsa` | EKS with IAM Roles for Service Accounts | none |
| `env` | Local dev / CI | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `instance-profile` | EC2 / ECS | none |
