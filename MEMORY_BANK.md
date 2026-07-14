# Memory Bank — devops-ai-agent

## Project Overview
AI Agent for DevOps incident investigation and Root Cause Analysis (RCA). Uses Slack as the interface, Claude/private LLM as the reasoning engine, and devops-mcp-server as the observability data source.

## Tech Stack
- **Runtime:** Node.js >= 24, TypeScript (ESM)
- **Slack:** `@slack/bolt` v4 (Socket Mode or HTTP Mode)
- **LLM:** `@anthropic-ai/sdk` v0.100.1 (Claude) + `openai` SDK (OpenAI-compatible) + `SQSLLMClient` (private LLM)
- **MCP Client:** `@modelcontextprotocol/sdk` v1.29.0
- **Memory:** In-memory Map or Redis (`ioredis`)
- **Build:** `tsc` → `dist/`, dev via `tsx watch`

## Architecture

```
Slack mention / Alertmanager webhook
        ↓
   AlertDeduplicator (fingerprint + TTL 12h)
        ↓
   DevOpsAgent.investigate(threadId, message)
        ↓ (checks hasRca flag → prepend [FOLLOW-UP] if true)
   LLM.chat(history, tools, systemPrompt)
        ↓ (agentic loop, max 10 iterations, parallel tool calls)
   MCPClient.callTool() → devops-mcp-server
        ↓
   RCA text → isRcaResponse() → Block Kit or plain mrkdwn
        ↓
   markRcaSent(threadId) → Redis key rca:{threadId}
        ↓
   parseConfidence() → notify oncall users if Low
```

## Key Design Decisions

### Response Mode = per-message markers (do not remove any of them)
Distant system-prompt rules alone do NOT hold — the model defaults to RCA format for any
first message. Every entry point stamps a marker; the system prompt keys its mode rules on them:
- **Alert path** (`investigateAlertInBackground`) → `[SOURCE: Alertmanager webhook — automated incident investigation]` → investigation mode mandatory.
- **Mention path** (`handleMention`) → `[USER MESSAGE — conversation mode by default ...]` → conversational unless the human explicitly asks to investigate. Added after testing showed "check status semua pod" produced a full Critical-severity RCA about a routine rolling deploy.
- **Follow-up** (after `markRcaSent(threadId)` flags `rca:{threadId}`) → `[FOLLOW-UP — conversation mode, do NOT use RCA format]` prepended in `investigate()`.
Prompt-side rules live in `prompts/system.md` §Response Mode (also forbids inventing an "incident" from routine activity like a rolling deploy).

### Tool budget (deterministic scope guard for conversation mode)
Prompt scope-rules alone did NOT stop the model from chasing anomalies (nginx logs full of
"upstream timed out" → it wandered into `monitoring`/Prometheus/Loki on a plain "show me
logs" question). Enforced in code instead:
- `investigate(threadId, msg, { maxToolRounds })` — plain mentions get **3 tool rounds**; after that `llm.chat` is called with **no tools** + a `[TOOL BUDGET REACHED ...]` note appended to the last tool_results, so the model must answer from gathered data (anomaly → one line + offer to investigate).
- If the model still emits `tool_use` with no tools offered, synthesized error tool_results keep the pairing intact and the loop continues (bounded by `MAX_ITERATIONS`).
- `wantsInvestigation(text)` (`agent/intent/`, keyword regex en+id, unit-tested) grants the full budget for explicit requests ("investigate", "investigasi", "kenapa", "why", "rca", ...). Alert path always has the full budget.
- All three LLM paths **omit the `tools` param when the array is empty** (claude.ts, openai-compatible.ts, and llm-worker/src/llm.ts) — some OpenAI-compatible backends reject `tools: []`. **llm-worker needs its own rebuild/redeploy for this.**
- **Format backstop (deterministic):** even with the budget note, the model sometimes composed its FINAL answer in RCA format when tool results looked alarming (nginx logs full of errors → `response type=rca` for a "show me logs" mention). `handleMention` now detects `!wantsInvestigation && isRcaResponse(reply)` and calls `agent.reformatToConversation(reply)` — one tool-less LLM call with a **minimal** system prompt (the full one is what primes the RCA structure). Falls back to the original text on failure. This is the last line: prompt rules → budget note → programmatic reformat.
- **Slack splitter (`utils/slack/split.ts`):** Slack hard-splits messages >~4000 chars and breaks ``` fences (continuation renders raw). Non-RCA mention replies are posted via `splitForSlack()` — newline-boundary chunks with fence re-balancing (close at chunk end, reopen at next chunk start). Unit-tested.
- **Log fan-out guard (deterministic):** in conversation mode, `k8s_get_pod_logs` for > `MAX_LOG_FANOUT` (2) distinct pods in one round is refused with a synthesized "list the pods and ask the user" error (other calls in the round still execute). Stops "show me log metallb" (matches 8 pods) from dumping every pod's logs; the model asks which one instead.
- **Namespace scope lock (deterministic, `agent/scope/`):** in conversation mode, the FIRST tool round defines the question's namespaces (the model's initial targeting has always been correct); later rounds calling into other namespaces are refused ("out of scope — answer with what you have / ask before expanding"). Kills the recurring failure where logs full of "upstream timed out" lured the model into `monitoring` on a plain "show me nginx logs" question. Namespace-less calls (prometheus/loki queries) and an empty first-round scope are never blocked. Unit-tested.
- `MENTION_TOOL_ROUNDS` default is **2** (was 3): discover → fetch covers the common flows exactly; a 3rd round only ever fed wandering. Tunable via env without rebuild.

### Reasoning-model token exhaustion (private-llm)
The private LLM is a reasoning model: `completion_tokens` includes hidden thinking, which
once consumed the ENTIRE 8096 budget → `finish_reason=length`, empty content, and the user
got a blank-response fallback. Chain of defenses:
- **llm-worker maps `finish_reason=length` → `max_tokens`** (was disguised as `end_turn`).
- **llm-worker auto-retry safeguard:** empty content + `max_tokens` → one retry with **2× token budget** (`isEmptyTokenExhaustion`, unit-tested). Partial answers are never retried.
- Agent's empty-response fallback names the fix (`LLM_MAX_TOKENS` / `LLM_REASONING_EFFORT`).
- Tuning (worker env): raise `LLM_MAX_TOKENS` (16384 recommended), optionally `LLM_REASONING_EFFORT=low` (only sent when set; remove if the backend rejects it).
- **Timeout coherence:** `SQS_LLM_TIMEOUT_SECONDS` default is **240** (was 120). A reasoning compose can take 60–90s, and the worker's 2× retry doubles that — 120s lost the race by 23s in testing (worker delivered a good answer 10:06:55; agent had timed out 10:06:32). The agent-side timeout must cover attempt + retry.
- **Tool-result truncation keeps head AND tail** (`truncateToolResult`, 4k+4k): logs are chronological — head-only truncation silently dropped the recent lines that "show me the logs" needs.

### System Prompt from Markdown
- `prompts/system.md` at project root — edit this file to update the prompt without rebuilding TypeScript
- `buildStaticSystemPrompt()` reads and caches the file on first call
- Path resolution supports both dev (`src/agent/prompts/`) and prod (`dist/src/agent/prompts/`)
- Dockerfile copies `prompts/` directory to image alongside `dist/`

### Truncated Log Formatting
- `src/utils/truncate/index.ts` — `truncate(value, max?)` helper
- Format: `...[truncated N chars]` — shows exactly how much was cut
- Used in: issue preview (120 chars), tool input log (200 chars)
- Tool result truncation in `context/index.ts` uses same format
- Log output itself is never truncated — only field values within log messages

### System Prompt Strategy
- `buildStaticSystemPrompt()` — large static prompt cached by Anthropic (`cache_control: ephemeral`)
- `buildTimeContext()` — called once per investigation, injects unix timestamps for tool params
- Time context prepended to first message only

### Block Kit Rendering
- `isRcaResponse(text)` — detects RCA via regex matching Severity + Root Cause labels
- Regex handles `Critical` and `[Critical]` (LLM sometimes adds brackets)
- `buildRcaBlocks(text)` — parses RCA text into Slack Block Kit blocks
- Fallback: if parsing fails (blocks <= 2), returns single section block with raw text

### MCP Client Reconnect
- Exponential backoff: 1s → 2s → 4s → 8s → 16s (max 5 retries)
- `reconnectMutex` — prevents race condition when parallel tool calls hit disconnect simultaneously
- Double-check pattern: verify `connected` state before and after acquiring mutex

### Timeouts (don't let one investigation stall the agent)
- `MCP_TOOL_TIMEOUT_SECONDS` (default 45) → passed as the MCP SDK `callTool` request `timeout`; a hung MCP server/upstream rejects the call instead of blocking. Set below the SDK's 60s default and above the MCP server's own upstream timeout so the server's specific error surfaces first.
- `INVESTIGATION_TIMEOUT_SECONDS` (default 300) → wall-clock budget checked at the top of each agentic-loop iteration in `investigate()`. Bounds how long a `Semaphore` slot is held (`MAX_ITERATIONS=10` only bounds iteration count, not time). Combined with the per-tool timeout, total runtime is bounded to ~budget + one in-flight call.
- **Env vars are in seconds; config converts to ms internally** (`* 1000`) since `setTimeout`/SDK/axios take ms. Internal field names keep the `Ms` suffix.

### Context Window Management
- Tool results truncated to 8000 chars before entering history
- `trimToWindow(messages, max)` in `context/index.ts` is the single pairing-aware trimmer: keeps first message (original issue) + most recent, and advances the window past any leading orphaned `tool_result`
- Used by both layers: model window = 40 (`trimHistory`), storage cap = 50 (`memory.append`)
- **Never reintroduce a blind `slice`/`splice`** — it can drop the issue or split a `tool_use`/`tool_result` pair, which the Anthropic API rejects with a 400 on long investigations

### Alert Deduplication (multi-pod safe)
- Fingerprint: all labels sorted and joined → stable string
- TTL: 12 hours (matches Alertmanager `repeat_interval`)
- **Redis-backed when `MEMORY_BACKEND=redis`:** the claim is an atomic `SET dedup:{fp} 1 EX <ttl> NX` — returns `"OK"` only for the first pod to see the alert, so under autoscaling N pods can't all investigate the same alert. In-memory `Map` is the **single-pod fallback** when Redis isn't configured.
- Reuses the **one shared Redis connection** (`src/redis.ts` singleton, `getRedis()`), same client as conversation memory — zero new deps, zero extra connection. `shouldProcess()` is now **async** (Redis call); caller `await`s it in `handleAlert`.
- `dedup/index.test.ts` covers the in-memory fallback path (first-vs-repeat, label-order stability, TTL expiry).

### Readiness `/health`
- `GET /health` calls `agent.healthCheck()` → checks MCP (`isConnected()` flag) + Postgres (`SELECT 1`, only if incidents enabled) + Redis (`PING`, only if backend=redis).
- Returns **`503`** when any configured dependency is down, `200` + `{checks}` when all up — so K8s readiness probes stop routing to a pod that can't investigate. Wire `readinessProbe: httpGet /health` in the Deployment.
- MCP check is a **real MCP `ping` request** (5s timeout) — upgraded from the cached connect flag after testing hit the dead-but-flagged-up case (MCP down after startup, `/health` still 200). On ping failure it also flips `connected` so the next tool call takes the reconnect path.
- The **MCP server itself** probes its upstreams (Prometheus/Loki/tracing) at startup and logs `Upstream UNREACHABLE` warnings — non-fatal by design (Prometheus down must not take k8s tools down). Surfaces wrong `PROMETHEUS_URL`-style misconfig at deploy time instead of first tool call.

### MCP HTTP Auth (shared bearer token)
- Set the **same `MCP_AUTH_TOKEN`** on the agent and the MCP server (from one K8s Secret).
- Agent: `StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: \`Bearer <token>\` } } })` when set (`mcp/client.ts`).
- Server (`devops-mcp-server/src/app/index.ts`): middleware on `/mcp` requires the bearer token, returns `401` otherwise; `/health` stays open for probes. Compare via `timingSafeEqualStr` (sha256 → `crypto.timingSafeEqual`) — constant-time, never leaks token length. Token unset → open but logs a **warning** in http mode (never silently open). `auth.test.ts` covers match / equal-length-mismatch / different-length-no-throw.
- **Prerequisite for write/remediation tools** — never expose a state-changing tool behind an unauthenticated transport.

### LLM Output Tokens / Model
- `MAX_TOKENS` env (default `8096`) caps output for the **claude + openai-compatible** paths (`config.llm.maxTokens`); was hardcoded in `claude.ts` and entirely missing in `openai-compatible.ts` (so it used the provider default and could truncate).
- `CLAUDE_MODEL` default is `claude-opus-4-8` (latest opus tier). SQS path's model + token limit live in **llm-worker**, not here — don't push them from the agent (two sources of truth).

### Incident Memory (durable, `agent/incidents/index.ts`)
- **Purpose:** learn from past RCAs — recall prior resolved incidents for the same `(alertname, namespace)` and inject a compact digest into the prompt so recurring incidents aren't re-diagnosed cold.
- **Store = Postgres (`pg`), NOT Redis.** Redis here is a cache (conversation memory, 24h TTL, evictable); incident memory is a system-of-record that must persist for months. Enabled only when `DB_HOST` is set (discrete `DB_*` vars → `pg.Pool` via `db/pool.ts`; `DB_SSL_MODE` maps to pg's `ssl`); `IncidentMemory(null)` is a safe no-op otherwise (single-pod dev works without Postgres).
- **Schema = versioned migrations, NOT inline DDL.** `migrations/*.sql` applied by a framework-free runner (`db/migrate.ts`, uses installed `pg`): tracks applied files in `schema_migrations`, each in a txn, guarded by a **`pg_advisory_lock`** so concurrent pod startups (autoscaling) serialize instead of racing on `CREATE TABLE`. `runMigrations()` runs on agent startup AND via `npm run migrate` / `migrate:prod` (for a K8s Job/initContainer). `migrations/` is copied into the Docker image. Add changes as `002_*.sql`. `pendingMigrations()` (pure: filter/sort/skip-applied) is unit-tested. `IncidentMemory` no longer does DDL.
- **Wiring:** owned by `DevOpsAgent` (alongside Redis/memory init), exposed as `recallIncidents(labels)` / `storeIncident(labels, rca)`. App calls them only on the **alert path** (`investigateAlertInBackground`) where `alert.labels` give `alertname`/`namespace`; recall + store are best-effort (`.catch`) so a DB failure never breaks an investigation. Mentions have no labels → not stored.
- **Recall = exact label match, no vector DB** (`// ponytail:` add embeddings only if too coarse). Past incidents framed as **Hypothesis to verify** (system prompt + injected block) to avoid anchoring on a stale root cause.
- `parseConfidence` reused; `parseSeverity` + `extractRootCause` are local, unit-tested in `incidents/index.test.ts`.

### On-call Feedback Learning (`@agent learn` — trust-tiered memory)
Design: `docs/DESIGN_oncall_feedback_learning.md`. Two tiers, never flattened:
**hypothesis** (agent RCA, `incidents`) vs **CONFIRMED** (human, `incident_feedback`).
- **Trigger (v1): explicit** — `@agent learn` inside an alert thread (keyword-routed in `handleMention`, `/^learn\b/i`). No broad `message.channels` scope; the human decides what's worth learning. `reaction_added` (✅) is the planned second trigger; passive capture is v2.
- **Flow:** thread → `findIncidentByThread(channel, thread_ts)` (linked since migration 002) → `conversations.replies` transcript (`buildTranscript`: humans vs agent labeled, tail-biased 6k cap) → ONE tool-less extraction LLM call (minimal system prompt) → `parseFeedbackJson` (tolerant: fences/prose, outcome normalized, null when nothing substantive) → `storeFeedback`.
- **Idempotent:** `trigger_key` = ts of the learn message; unique `(incident_id, trigger_key)` → code `23505` mapped to "duplicate". Re-learning after a correction = new message ts = new row (latest rows win in recall).
- **Recall renders CONFIRMED first** as a strong prior ("check this hypothesis FIRST, mention the past fix in Recommended Actions"), hypotheses after ("verify before reuse"). Framing lives in both the injected block and `prompts/system.md` Evidence Rules.
- The ack echoes what was learned so on-call can correct mistakes (extraction quality mitigation). `raw_excerpt` stored for provenance.
- Feeds Guarded Remediation later: `action_taken` history informs/annotates action proposals.

## LLM Providers

| `LLM_PROVIDER` | Class | Notes |
|----------------|-------|-------|
| `claude` | `ClaudeClient` | Anthropic SDK, prompt caching |
| `openai-compatible` | `OpenAICompatibleClient` | Any OpenAI-compatible API |
| `private-llm` | `SQSLLMClient` | Event-driven via SQS, for strict private networks |

### Private LLM via SQS
- Agent publishes `{ requestId, messages, tools, systemPrompt }` to the shared SQS Request Queue
- **Shared response queue + one dispatcher per process:** a single `dispatchLoop()` per replica polls the shared response queue and routes each message to the waiting `chat()` call via `Map<requestId, waiter>` (`pending`). Replaces the old design where every concurrent investigation polled independently and **skipped non-matching messages without releasing them** — leaving them invisible for the whole visibility timeout and stalling the rightful waiter.
- SQS has no selective receive, so a replica can pull another replica's response. Routing in `routeMessage()`:
  - ours & awaited → delete + resolve/reject
  - ours & already done (timed out) → delete — `issued` tombstone (TTL 2× timeout) recognises our own late/duplicate responses so they aren't bounced around
  - not ours → `ChangeMessageVisibility` release so the owner can grab it: `releaseVisibilitySeconds()` returns `0` (instant) up to `RELEASE_FAST_LIMIT=20` receives, then `60`s backoff so a true orphan (requester died) can't hot-loop the queue — SQS retention eventually clears it
- `chat()` registers the waiter, publishes, awaits a promise resolved by the dispatcher; per-request `setTimeout` enforces `SQS_LLM_TIMEOUT_SECONDS` (default 120)
- **Shutdown:** `SQSLLMClient.shutdown()` (via optional `LLMClient.shutdown?()`, called from `DevOpsAgent.shutdown()`) aborts the dispatcher and rejects pending waiters. No queues to delete — the response queue is shared, so **no per-replica queue sprawl** even under autoscaling.
- **SQSClient has explicit timeouts** (`requestHandler: { connectionTimeout, requestTimeout }`, `maxAttempts: 3`). Critical: the dispatcher is the **single** deliverer of all LLM responses — a hung SQS call (no timeout) once froze it permanently, so it delivered a couple of responses then silently stalled and every later investigation timed out. `requestTimeout = (pollWaitSeconds + 15)s` so the long-poll receive isn't cut short.
- IAM (private-llm provider): `sqs:SendMessage/ReceiveMessage/DeleteMessage/ChangeMessageVisibility/GetQueueUrl/CreateQueue` on `llm-*.fifo`
- Rejected alternative: per-instance reply-to queue (`llm-response-<podname>.fifo`). Cleaner routing but creates one queue per pod → list grows, orphans on hard crash. Chose the shared-queue dispatcher to keep the queue count constant at 3.

## Slack Modes

### Socket Mode (recommended for K8s)
- Set `SLACK_APP_TOKEN=xapp-...`
- Bolt connects outbound WebSocket — no public URL / Ingress needed
- Alertmanager webhook runs on separate Express server on same port

### HTTP Mode
- No `SLACK_APP_TOKEN`
- Requires publicly reachable Ingress/LoadBalancer
- `SLACK_SIGNING_SECRET` verifies request authenticity

## Environment Variables
```
SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN
SLACK_ALERT_CHANNEL, SLACK_ONCALL_USERS

LLM_PROVIDER            # claude | openai-compatible | private-llm
ANTHROPIC_API_KEY, CLAUDE_MODEL   # default claude-opus-4-8
OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_MODEL
MAX_TOKENS              # output ceiling for claude + openai-compatible (default 8096)

# Private LLM (SQS)
SQS_REGION, SQS_REQUEST_QUEUE_NAME, SQS_RESPONSE_QUEUE_NAME
SQS_LLM_TIMEOUT_SECONDS, SQS_POLL_WAIT_SECONDS
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  # local dev only; use IRSA on EKS

MCP_TRANSPORT, MCP_STDIO_ARGS, MCP_HTTP_URL
MCP_AUTH_TOKEN          # bearer token for MCP http transport; must match the server's MCP_AUTH_TOKEN
MEMORY_BACKEND, REDIS_HOST, REDIS_PORT, REDIS_DB, REDIS_PASSWORD, REDIS_TLS   # conversation cache + multi-pod dedup
DB_HOST, DB_PORT, DB_NAME, DB_USERNAME, DB_PASSWORD, DB_SSL_MODE   # durable incident memory; disabled if DB_HOST unset
MAX_CONCURRENT_INVESTIGATIONS
LOG_LEVEL   # error | warn | info | http | debug
```

## File Structure
```
src/
├── agent/
│   ├── index.ts                  # Orchestrator — agentic loop, parallel tool calls
│   ├── confidence/index.ts       # parseConfidence() — anchored regex, no false positives
│   ├── context/index.ts          # trimHistory(), sanitizeContentBlocks()
│   ├── dedup/index.ts            # AlertDeduplicator: fingerprint + TTL
│   ├── llm/
│   │   ├── index.ts              # createLLMClient() factory
│   │   ├── claude.ts             # Anthropic + prompt caching
│   │   ├── openai-compatible.ts
│   │   ├── sqs.ts                # SQSLLMClient: queue name resolution + auto-create
│   │   └── types.ts
│   ├── incidents/index.ts        # IncidentMemory: durable recall/store (Postgres) + ping()
│   ├── mcp/client.ts             # MCPClient: reconnect + mutex + isConnected() + bearer auth
│   ├── memory/index.ts           # Redis/in-memory, hasRca/markRcaSent
│   └── prompts/system.ts         # buildStaticSystemPrompt(), buildTimeContext()
├── app/index.ts                  # SlackApp: Bolt + ExpressReceiver + /health readiness + error handler
├── config/index.ts
├── redis.ts                      # Shared Redis singleton (conversation memory + alert dedup)
├── db/                           # pool.ts (DB_* → pg.Pool), migrate.ts (advisory-locked runner), migrate-cli.ts
└── utils/
    ├── logger/index.ts           # Winston, LOG_LEVEL support
    └── slack/blocks.ts           # isRcaResponse(), buildRcaBlocks()
```

## AWS Authentication

Controlled by `AWS_AUTH_MODE` env var (read by `entrypoint.sh`):

| Mode | Setup | Use case |
|------|-------|----------|
| `iam-anywhere` | Writes `~/.aws/config` with `credential_process` pointing to `aws_signing_helper` | On-premise / private network with X.509 cert |
| `irsa` | No setup — IRSA injects credentials via projected service account token | EKS with IRSA |
| `env` | No setup — `AWS_ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` already in env | Local dev, CI/CD |
| `instance-profile` | No setup — EC2 instance metadata used | EC2, ECS |

Default is `iam-anywhere` for backward compat — **set `AWS_AUTH_MODE=irsa` on EKS**.

Required only for `iam-anywhere`: `AWS_TRUST_ANCHOR_ARN`, `AWS_ROLESANYWHERE_PROFILE_ARN`, `AWS_ROLE_ARN`, `CERT_PATH`, `CERT_KEY_PATH`.

## Bugs Fixed
1. **"Already connected to transport"** — MCP server HTTP mode creates new McpServer per request
2. **Follow-up always returns RCA format** — `[FOLLOW-UP]` prefix + `markRcaSent` Redis flag
3. **Block Kit not rendering** — LLM outputs `[Critical]`; regex handles both forms
4. **Race condition on reconnect** — `reconnectMutex` in MCPClient
5. **False positive confidence** — regex anchored to label
6. **Orphaned `tool_result` on long investigations** — two independent trimmers (`trimHistory` keep-first + `memory.append` blind splice) could drop the issue or split a `tool_use`/`tool_result` pair → Anthropic 400. Unified into pairing-aware `trimToWindow()`; covered by `context/index.test.ts`
7. **`/alert` webhook held open during investigation** — awaited the full multi-minute investigation before replying, causing Alertmanager timeouts/retries and late notifications for batched alerts. Now acks `200` immediately and investigates in the background (see Alert Webhook is Async)
8. **SQS response polling stalled waiters across concurrent investigations / replicas** — every concurrent investigation polled the shared response queue and skipped non-matching messages **without releasing them**, so they stayed invisible for the visibility timeout and the rightful waiter stalled (worse under autoscaling). Now a single dispatcher per process + `ChangeMessageVisibility` release with orphan backoff (see Private LLM via SQS); `releaseVisibilitySeconds` covered by `llm/sqs.test.ts`
9. **Empty RCA → Slack `no_text`** — when the model's final turn had no text, `investigate()` returned `""` and `chat.postMessage({ text: "" })` failed with `no_text`. `investigate()` now substitutes a fallback message so the return is never empty.

## Testing
- `npm test` → `node --import tsx --test 'src/**/*.test.ts'` (Node >= 24 built-in runner + tsx, zero new deps)
- Test files (`*.test.ts`) excluded from `tsc` build so `dist/` stays clean
- Covered so far: `trimToWindow`/`trimHistory` pairing invariants, `truncateToolResult`, `sanitizeContentBlocks`, `ConversationMemory` (in-memory backend)

### Alert Webhook is Async (do not re-block it)
- `POST /alert` validates the payload, returns `200` **immediately**, then processes in the background
- Inside `handleAlert`: each alert's Slack notification is posted up front (sequential, fast); the investigation is fired via `void investigateAlertInBackground(...)` so it never delays the next alert's notification or the webhook ack
- Background concurrency is bounded by the existing `Semaphore`; failures are caught and posted into the alert thread
- **Why:** investigations take minutes — awaiting them held the connection open past Alertmanager's seconds-long webhook timeout (causing retries) and serialized notifications so later alerts in a batched payload appeared late
- Trade-off: after the `200` ack a crash loses the in-flight RCA (not the alert — it's already in Slack); Alertmanager `repeat_interval` + in-memory dedup reset on restart re-trigger it. Graceful-shutdown drain of in-flight investigations is a possible follow-up.

## Alertmanager Config Notes
- `group_by: ["alertname", "namespace"]` — one webhook per alert+namespace
- `repeat_interval: 12h` — agent dedup TTL matches this
- Label templating in `labels:` block NOT resolved by Prometheus — use `annotations:` only
- `startsAt` included in issueText as unix timestamp for query anchoring

## Roadmap / Backlog

### Done (recent)
- [x] **Distributed tracing** (3rd observability pillar) — Tempo/Jaeger adapters in devops-mcp-server (`tracing_search` / `tracing_get_trace` / `tracing_list_services`)
- [x] **Durable incident memory** (Postgres + framework-free migrations)
- [x] **Multi-pod alert dedup** (Redis `SET NX`) — replaces the old in-memory-only dedup
- [x] **Readiness `/health`** (503 when MCP/Postgres/Redis down)
- [x] **Configurable `MAX_TOKENS` + model default refresh** (`claude-opus-4-8`)
- [x] **MCP HTTP auth** (shared bearer token, constant-time check)
- [x] **Migration 002** — `remediations` + `incident_feedback` tables, `incidents.thread_ts/channel`, `storeIncident` returns id (shared prerequisite for C + E)
- [x] **Conversation-mode hardening** (chatbot UX for non-alert mentions) — response-mode markers, tool budget, namespace scope lock, log fan-out guard, RCA-format backstop, fence-safe Slack splitter, head+tail truncation, name-resolution/confirmation + 10-line log display rules
- [x] **Reasoning-model resilience** (llm-worker) — `finish_reason=length` surfaced as `max_tokens`, empty-exhaustion auto-retry with 2× budget, `LLM_REASONING_EFFORT` passthrough, `SQS_LLM_TIMEOUT_SECONDS` default 240
- [x] **MCP server ops polish** — startup upstream probe (non-fatal warn), `conciseCause` error trimming, no stack for expected errors; agent `/health` does a real MCP ping

### Next — ordered
- [ ] **D. Resolved-alert loop** — handle Alertmanager `status: resolved` (currently skipped): post a "✅ resolved" update to the incident thread + record outcome in DB. Becomes a **feedback signal** for incident-memory quality. Small.
- [ ] **C. Guarded Remediation** — agent executes actions (restart/scale/rollback) via the alert thread with a Slack **approval gate** + DB audit trail. Design agreed → **`docs/DESIGN_guarded_remediation.md`**. ✅ Step 1 done (migration 002: `remediations` table + partial unique index). Next: Step 2 (`k8s_rollout_restart` + `MCP_ENABLE_WRITE_TOOLS` in mcp-server).
- [ ] **E. On-call feedback learning** — Design → **`docs/DESIGN_oncall_feedback_learning.md`**. ✅ **v1 shipped** (steps 1–4: migration 002, feedback store/recall, `@agent learn` router + extraction, confirmed-tier recall + prompt framing). Remaining: Step 5 (`reaction_added` ✅ trigger, needs `reactions:read`), then v2 ideas (passive capture, auto-trigger on resolve).
- Migration **`002_remediations_and_feedback.sql`** ships the shared schema for C+E in one transaction; `store()` now takes an optional `{channel, threadTs}` and returns `incidents.id` (`Number()`-cast — pg returns BIGSERIAL as string).

### Parked (design captured, revisit when prioritized)
- **FinOps** (cost Q&A, waste audit, cost-anomaly-as-incident, rightsizing) — mostly config/prompt via OpenCost→Prometheus; see **`docs/DESIGN_finops.md`**.
- **VM/baremetal execution** via Ansible-backed MCP tools — deemed too complex for now; K8s + observability scope only. Key notes: whitelist = curated playbooks (never generic exec), `--check` = dry-run, plain-CLI-vs-AWX decides the architecture.

### Tier 3 — skip until justified (YAGNI)
- [ ] Semantic/vector recall for incident memory (exact-label match is enough until incidents number in the hundreds)
- [ ] Alert correlation/grouping — one investigation when many pods fail in the same namespace
- [ ] Self-metrics endpoint (agent exposes its own Prometheus metrics; token usage already logged)
- [ ] `/clear` Slack command to reset thread history
- [ ] Configurable confidence threshold via env var
- [ ] Webhook auth for the `/alert` endpoint (Alertmanager → agent; distinct from MCP auth)
- [ ] Graceful-shutdown drain of in-flight investigations
