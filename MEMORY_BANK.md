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

### Follow-up vs Investigation Mode
- After RCA is posted, `markRcaSent(threadId)` stores `rca:{threadId}` in Redis
- Follow-up messages are prepended with `[FOLLOW-UP — conversation mode, do NOT use RCA format]`
- **Do not remove this prefix** — without it, LLM defaults to RCA format regardless of context

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

### Alert Deduplication
- Fingerprint: all labels sorted and joined → stable string
- TTL: 12 hours (matches Alertmanager `repeat_interval`)

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
ANTHROPIC_API_KEY, CLAUDE_MODEL
OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_MODEL

# Private LLM (SQS)
SQS_REGION, SQS_REQUEST_QUEUE_NAME, SQS_RESPONSE_QUEUE_NAME
SQS_LLM_TIMEOUT_SECONDS, SQS_POLL_WAIT_SECONDS
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  # local dev only; use IRSA on EKS

MCP_TRANSPORT, MCP_STDIO_ARGS, MCP_HTTP_URL
MEMORY_BACKEND, REDIS_HOST, REDIS_PORT, REDIS_DB, REDIS_PASSWORD, REDIS_TLS
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
│   ├── mcp/client.ts             # MCPClient: reconnect + mutex
│   ├── memory/index.ts           # Redis/in-memory, hasRca/markRcaSent
│   └── prompts/system.ts         # buildStaticSystemPrompt(), buildTimeContext()
├── app/index.ts                  # SlackApp: Bolt + ExpressReceiver + error handler
├── config/index.ts
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

## Potential Improvements
- [ ] `/clear` Slack command to reset thread history
- [ ] Configurable confidence threshold via env var
- [ ] Persistent dedup storage (current in-memory resets on restart)
- [ ] Alert grouping — investigate once if many pods fail in same namespace
- [ ] Webhook auth for `/alert` endpoint
- [ ] SQS message visibility timeout > LLM inference time
