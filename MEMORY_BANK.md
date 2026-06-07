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

### Context Window Management
- Tool results truncated to 8000 chars before entering history
- History trimmed to 40 messages, always preserving first message (original issue)

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
- Agent publishes `{ requestId, messages, tools, systemPrompt }` to SQS Request Queue
- Polls Response Queue for matching `requestId`
- Queue URLs resolved from names via `GetQueueUrl`, auto-created if not exist
- Timeout: `SQS_LLM_TIMEOUT_MS` (default 120s)

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
SQS_LLM_TIMEOUT_MS, SQS_POLL_WAIT_SECONDS
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
