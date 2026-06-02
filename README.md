# DevOps AI Agent

AI-powered DevOps agent for incident investigation and Root Cause Analysis (RCA), integrated with Slack and backed by Kubernetes, Prometheus, and Loki observability data via MCP.

## How It Works

```
Slack mention / Alertmanager webhook
        ↓
   Alert deduplication (fingerprint + 12h TTL)
        ↓
   Agent investigates (agentic loop, max 10 iterations)
        ↓
   LLM calls MCP tools (K8s, Prometheus, Loki) in parallel
        ↓
   RCA posted to Slack thread as Block Kit
        ↓
   Confidence Low? → mention on-call users
```

## Requirements

- Node.js >= 24
- A running [devops-mcp-server](../devops-mcp-server)
- Slack app with scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`

## Setup

```bash
cp .env.example .env
# Edit .env with your credentials
npm install
npm run dev                    # development (tsx watch)
npm run build && npm start     # production
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | `dev` / `staging` / `prod` | `dev` |
| `PORT` | HTTP port | `3000` |
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) | required |
| `SLACK_SIGNING_SECRET` | App signing secret (HTTP mode) | required |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (`xapp-...`) | optional |
| `SLACK_ALERT_CHANNEL` | Channel ID for Alertmanager alerts | optional |
| `SLACK_ONCALL_USERS` | Comma-separated Slack user IDs to mention on Low confidence | optional |
| `LLM_PROVIDER` | `claude` or `openai-compatible` | `claude` |
| `ANTHROPIC_API_KEY` | Anthropic API key | required if Claude |
| `CLAUDE_MODEL` | Claude model name | `claude-opus-4-5` |
| `OPENAI_COMPATIBLE_BASE_URL` | Base URL for private LLM | required if openai-compatible |
| `OPENAI_COMPATIBLE_API_KEY` | API key for private LLM | — |
| `OPENAI_COMPATIBLE_MODEL` | Model name | `gpt-4` |
| `MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
| `MCP_STDIO_COMMAND` | Command to run MCP server | `node` |
| `MCP_STDIO_ARGS` | Args for MCP server (comma-separated) | — |
| `MCP_HTTP_URL` | MCP server HTTP URL | `http://localhost:3001/mcp` |
| `MEMORY_BACKEND` | `inmemory` or `redis` | `inmemory` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_DB` | Redis database index | `0` |
| `REDIS_USERNAME` | Redis username (optional) | — |
| `REDIS_PASSWORD` | Redis password (optional) | — |
| `REDIS_TLS` | Enable TLS (`true`/`false`) | `false` |
| `MAX_CONCURRENT_INVESTIGATIONS` | Max parallel investigations | `5` |
| `AWS_REGION` | AWS region for SQS (private-llm only) | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | FIFO queue name for LLM requests | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | FIFO queue name for LLM responses | `llm-response.fifo` |
| `SQS_LLM_TIMEOUT_MS` | Max wait time for LLM response (ms) | `120000` |
| `SQS_POLL_WAIT_SECONDS` | SQS long-poll wait per call (max 20) | `10` |

## Usage

### Manual Investigation via Slack

Mention the bot in any channel:

```
@devops-agent pods in namespace payment-service are crashing with OOMKilled
```

The agent investigates and replies in the thread with a full RCA.

### Follow-up Questions

Conversation history is maintained per Slack thread. After an RCA is posted, follow-up messages are handled in conversation mode (no RCA format):

```
@devops-agent show me the logs
@devops-agent when did this start?
@devops-agent what's the memory trend for the last hour?
```

### Alertmanager Integration

```yaml
# alertmanager.yml
receivers:
  - name: devops-ai-agent
    webhook_configs:
      - url: http://your-agent-host:3000/alert
        send_resolved: false

route:
  group_by: ["alertname", "namespace"]   # important: one webhook per alert+namespace
  repeat_interval: 12h
  receiver: devops-ai-agent
```

The agent posts the alert to `SLACK_ALERT_CHANNEL` and auto-investigates in the thread. Duplicate alerts (same labels) within 12 hours are silently suppressed.

## RCA Output Format

```
🔴 Critical Severity Incident          ← Slack header block

📍 Root Cause
Pod payment-api-xxx is OOMKilled due to a memory leak in the connection pool.

📊 Evidence
• Pod restarted 15 times in 30 minutes — k8s_list_events `pavenow-staging/payment-api`
• Memory at 98% of 512Mi limit — prometheus_query `pavenow-staging`
• "OutOfMemoryError" in logs — loki_query_range `pavenow-staging`

🚫 Ruled Out
• Network issue — no connection errors found in events

🔧 Recommended Actions
1. Immediate: Increase memory limit to 1Gi
2. Short-term: Review connection pool configuration
3. Long-term: Implement HPA with proper resource profiling

⚠️ Impact if Unresolved
Complete payment service outage

📈 Confidence: `High` — three independent sources confirm the same root cause
```

When confidence is **Low**, all users in `SLACK_ONCALL_USERS` are automatically mentioned in the thread.

## Key Features

| Feature | Details |
|---------|---------|
| **Alert Deduplication** | Same alert (identical labels) processed once per 12-hour window |
| **MCP Reconnect** | Exponential backoff (1s→2s→4s→8s→16s, max 5 retries), mutex-protected |
| **Context Window Management** | Tool results truncated to 8000 chars, history trimmed to 40 messages |
| **Confidence Threshold** | Low confidence → auto-mention all `SLACK_ONCALL_USERS` in thread |
| **Follow-up Mode** | After RCA is posted, subsequent mentions are handled conversationally |
| **Prompt Caching** | System prompt cached by Anthropic (ephemeral) — reduces token cost on long investigations |
| **Parallel Tool Calls** | Independent tool calls executed in parallel per LLM iteration |
| **Multi-LLM Support** | Claude (Anthropic) or any OpenAI-compatible API (private LLM) |
| **Redis Memory** | Conversation history persisted in Redis with 24h TTL (optional) |

## Project Structure

```
src/
├── agent/
│   ├── index.ts                  # Orchestrator — agentic loop
│   ├── confidence/index.ts       # Parse confidence level from RCA text
│   ├── context/index.ts          # Context window management
│   ├── dedup/index.ts            # Alert deduplication (fingerprint + TTL)
│   ├── llm/
│   │   ├── index.ts              # LLM factory
│   │   ├── claude.ts             # Anthropic Claude client (with prompt caching)
│   │   ├── openai-compatible.ts  # OpenAI-compatible client
│   │   └── types.ts              # Shared LLM types
│   ├── mcp/client.ts             # MCP client with reconnect + mutex
│   ├── memory/index.ts           # Conversation history + RCA flag (Redis/in-memory)
│   └── prompts/system.ts         # Static system prompt + dynamic time context
├── app/index.ts                  # Slack Bolt app + Alertmanager webhook
├── config/index.ts               # Configuration
└── utils/
    ├── logger/index.ts           # Winston logger
    └── slack/blocks.ts           # isRcaResponse(), buildRcaBlocks()
```

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. **OAuth & Permissions** → Add scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`
3. **Event Subscriptions** → Enable, subscribe to `app_mention`
4. **Install to Workspace** → copy Bot Token and Signing Secret to `.env`
5. For Socket Mode (no public URL): enable Socket Mode, generate App Token with `connections:write` scope, set `SLACK_APP_TOKEN`

## Docker

```bash
# Build
docker build -t devops-ai-agent .

# Run
docker run -p 3000:3000 \
  -e SLACK_BOT_TOKEN=xoxb-... \
  -e SLACK_SIGNING_SECRET=... \
  -e SLACK_APP_TOKEN=xapp-... \
  -e ANTHROPIC_API_KEY=... \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_URL=http://devops-mcp-server:3000/mcp \
  -e MEMORY_BACKEND=redis \
  -e REDIS_HOST=redis \
  devops-ai-agent
```

## Private LLM via SQS

For LLMs hosted in a strict private network (no inbound exceptions), use the event-driven SQS transport. The agent publishes requests to SQS and polls for responses — the private network only needs outbound access to AWS SQS.

```
EKS (devops-ai-agent)          Private Network
        ↓ publish               ↑ poll
  SQS Request Queue  ──────────── llm-worker
  SQS Response Queue ──────────── llm-worker
        ↑ poll                  ↓ call
                            Private LLM API
```

Set `LLM_PROVIDER=private-llm` and configure SQS queue names. Queues are **auto-created** if they don't exist.

See [llm-worker](../llm-worker) for the worker service deployed in the private network.
