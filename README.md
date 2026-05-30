# DevOps AI Agent

AI-powered DevOps agent for incident investigation and Root Cause Analysis (RCA), integrated with Slack and backed by Kubernetes, Prometheus, and Loki observability data via MCP.

## How It Works

```
Slack mention / Alertmanager webhook
        ↓
   Alert deduplication check
        ↓
   Agent receives issue
        ↓
   LLM reasons → calls MCP tools (K8s, Prometheus, Loki)
        ↓
   Multi-step investigation (up to 10 iterations)
        ↓
   RCA + recommendations posted to Slack thread
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

## Usage

### Manual Investigation via Slack

```
@devops-agent pods in namespace payment-service are crashing with OOMKilled
```

The agent investigates and replies in the thread with a full RCA.

### Follow-up Questions

Conversation history is maintained per Slack thread:

```
@devops-agent when did this start?
@devops-agent are there any related alerts?
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
```

The agent posts the alert to `SLACK_ALERT_CHANNEL` and auto-investigates in the thread. Duplicate alerts (same labels) within 30 minutes are silently skipped.

## RCA Output Format

```
🔴 Severity: Critical

📍 Root Cause:
Pod payment-api-xxx is being OOMKilled due to a memory leak in the connection pool.

📊 Evidence:
- Pod restarted 15 times in the last 30 minutes — source: k8s_list_events
- Memory usage at 98% of 512Mi limit before each crash — source: prometheus_query
- Loki logs show "java.lang.OutOfMemoryError" — source: loki_query_range

🔧 Recommended Actions:
1. Immediate: Increase memory limit to 1Gi
2. Short-term: Review connection pool configuration
3. Long-term: Implement HPA with proper resource profiling

⚠️ Potential Impact if Unresolved:
Complete service outage for payment processing

📈 Confidence Level: High
```

When confidence is **Low**, all users in `SLACK_ONCALL_USERS` are automatically mentioned in the thread.

## Key Features

| Feature | Details |
|---------|---------|
| **Alert Deduplication** | Same alert (identical labels) processed once per 30-minute window |
| **MCP Reconnect** | Exponential backoff (1s→2s→4s→8s→16s, max 5 retries), auto-reconnect on tool failure |
| **Context Window Management** | Tool results truncated to 8000 chars, history trimmed to 40 messages |
| **Confidence Threshold** | Low confidence → auto-mention all `SLACK_ONCALL_USERS` in thread |
| **Dynamic System Prompt** | Built per-request with current timestamps for Prometheus/Loki queries |
| **Multi-LLM Support** | Claude (Anthropic) or any OpenAI-compatible API (private LLM) |

## Project Structure

```
src/
├── agent/
│   ├── index.ts                  # Orchestrator — agentic loop
│   ├── confidence/
│   │   └── index.ts              # Parse confidence level from RCA text
│   ├── context/
│   │   └── index.ts              # Context window management
│   ├── dedup/
│   │   └── index.ts              # Alert deduplication (fingerprint + TTL)
│   ├── llm/
│   │   ├── index.ts              # LLM factory
│   │   ├── claude.ts             # Anthropic Claude client
│   │   ├── openai-compatible.ts  # OpenAI-compatible client
│   │   └── types.ts              # Shared LLM types
│   ├── mcp/
│   │   └── client.ts             # MCP client with reconnect logic
│   ├── memory/
│   │   └── index.ts              # Conversation history per thread
│   └── prompts/
│       └── system.ts             # Dynamic system prompt
├── app/
│   └── index.ts                  # Slack Bolt app + Alertmanager webhook
├── config/
│   └── index.ts                  # Configuration
└── utils/
    └── logger/
        └── index.ts              # Winston logger
```

## Docker

```bash
# Build
docker build -t devops-ai-agent .

# Run
docker run -p 3000:3000 \
  -e SLACK_BOT_TOKEN=xoxb-... \
  -e SLACK_SIGNING_SECRET=... \
  -e ANTHROPIC_API_KEY=... \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_URL=http://devops-mcp-server:3000/mcp \
  devops-ai-agent
```

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. **OAuth & Permissions** → Add scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`
3. **Event Subscriptions** → Enable, subscribe to `app_mention`, set Request URL to `https://your-host/slack/events`
4. **Install to Workspace** → copy Bot Token and Signing Secret to `.env`
5. For Socket Mode (no public URL needed): enable Socket Mode, generate App Token with `connections:write` scope, set `SLACK_APP_TOKEN`
