# DevOps AI Agent

AI-powered DevOps agent for incident investigation and Root Cause Analysis (RCA), integrated with Slack and backed by Kubernetes, Prometheus, and Loki via MCP.

## How It Works

```
Slack mention / Alertmanager webhook
        ↓
   Alert deduplication (fingerprint + 12h TTL)
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
- Slack app with scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`

## Setup

```bash
cp .env.example .env
npm install
npm run dev
npm run build && npm start
npm test                       # unit tests
```

## Testing

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build, so `dist/` stays clean. Current coverage: history trimming with `tool_use`/`tool_result` pairing, tool-result truncation, conversation memory, and the SQS response-release backoff.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `SLACK_BOT_TOKEN` | `xoxb-...` | required |
| `SLACK_SIGNING_SECRET` | For HTTP mode | required |
| `SLACK_APP_TOKEN` | `xapp-...` for Socket Mode | optional |
| `SLACK_ALERT_CHANNEL` | Channel ID for Alertmanager alerts | optional |
| `SLACK_ONCALL_USERS` | Comma-separated user IDs, mentioned on Low confidence | optional |
| `LLM_PROVIDER` | `claude` / `openai-compatible` / `private-llm` | `claude` |
| `ANTHROPIC_API_KEY` | Required if claude | — |
| `CLAUDE_MODEL` | | `claude-opus-4-5` |
| `OPENAI_COMPATIBLE_BASE_URL` | Required if openai-compatible | — |
| `OPENAI_COMPATIBLE_API_KEY` | | — |
| `OPENAI_COMPATIBLE_MODEL` | | `gpt-4` |
| `SQS_REGION` | Required if private-llm | `ap-southeast-1` |
| `SQS_REQUEST_QUEUE_NAME` | | `llm-request.fifo` |
| `SQS_RESPONSE_QUEUE_NAME` | | `llm-response.fifo` |
| `SQS_LLM_TIMEOUT_SECONDS` | Max wait for LLM response | `120` |
| `SQS_POLL_WAIT_SECONDS` | | `10` |
| `AWS_ACCESS_KEY_ID` | Local dev only — use IRSA on EKS | — |
| `MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
| `MCP_STDIO_ARGS` | Path to MCP server `dist/index.js` | — |
| `MCP_HTTP_URL` | | `http://localhost:3001/mcp` |
| `MCP_TOOL_TIMEOUT_SECONDS` | Per-tool-call timeout (a hung MCP server can't stall an investigation) | `45` |
| `MEMORY_BACKEND` | `inmemory` or `redis` | `inmemory` |
| `REDIS_HOST` | | `localhost` |
| `REDIS_PORT` | | `6379` |
| `REDIS_DB` | | `0` |
| `REDIS_PASSWORD` | | — |
| `REDIS_TLS` | | `false` |
| `MAX_CONCURRENT_INVESTIGATIONS` | | `5` |
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

### Alertmanager Integration

```yaml
receivers:
  - name: devops-ai-agent
    webhook_configs:
      - url: http://your-agent:3000/alert
        send_resolved: false
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
| Alert Deduplication | Same alert processed once per 12h |
| MCP Reconnect | Exponential backoff + mutex-protected |
| Context Window | Tool results truncated to 8000 chars, history to 40 messages |
| Confidence Threshold | Low → auto-mention `SLACK_ONCALL_USERS` |
| Follow-up Mode | `markRcaSent` flag prevents RCA format on follow-ups |
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
│   ├── mcp/client.ts             # Reconnect + mutex
│   ├── memory/index.ts           # Redis/in-memory + hasRca/markRcaSent
│   └── prompts/system.ts         # Static prompt + time context
├── app/index.ts                  # Slack Bolt + Alertmanager webhook
├── config/index.ts
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
2. **OAuth & Permissions** → scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`
3. **Event Subscriptions** → subscribe to `app_mention`
4. Copy Bot Token + Signing Secret to `.env`
5. Socket Mode: enable + generate App Token with `connections:write`

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
