# Memory Bank — devops-ai-agent

## Project Overview
AI Agent for DevOps incident investigation and Root Cause Analysis (RCA). Uses Slack as the interface, Claude/private LLM as the reasoning engine, and devops-mcp-server as the observability data source.

## Tech Stack
- **Runtime:** Node.js >= 24, TypeScript (ESM)
- **Slack:** `@slack/bolt` v4 (Socket Mode or HTTP Mode)
- **LLM:** `@anthropic-ai/sdk` v0.100.1 (Claude) + `openai` SDK (OpenAI-compatible)
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
        ↓ (agentic loop, max 10 iterations)
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
- After RCA is posted, `markRcaSent(threadId)` is called → stores `rca:{threadId}` in Redis
- Follow-up messages are prepended with `[FOLLOW-UP — conversation mode, do NOT use RCA format]`
- This is critical — without this prefix, the LLM defaults to RCA format regardless of context
- **Do not remove this prefix**

### System Prompt Strategy
- `buildStaticSystemPrompt()` — large static prompt cached by Anthropic (`cache_control: ephemeral`)
- `buildTimeContext()` — called once per investigation, injects unix timestamps for tool params
- Time context is prepended to the first message only (not every message)
- Prompt contains failure playbooks (CrashLoopBackOff, OOMKilled, etc.) to guide investigation

### Block Kit Rendering
- `isRcaResponse(text)` — detects RCA output via regex matching Severity + Root Cause labels
- `buildRcaBlocks(text)` — parses RCA text into Slack Block Kit blocks
- Regex handles both `Critical` and `[Critical]` (LLM sometimes adds brackets despite prompt instructions)
- Fallback: if parsing fails (blocks <= 2), returns a single section block with raw text

### MCP Client Reconnect
- Exponential backoff: 1s → 2s → 4s → 8s → 16s (max 5 retries)
- `reconnectMutex` — prevents race condition when parallel tool calls all hit disconnect simultaneously
- Double-check pattern: verify `connected` state before and after acquiring the mutex

### Context Window Management
- Tool results truncated to 8000 chars before entering history
- History trimmed to 40 messages, always preserving the first message (original issue)
- `trimHistory()` called on every LLM iteration, not on append

### Alert Deduplication
- Fingerprint: all labels sorted and joined → stable string
- TTL: 12 hours (matches Alertmanager `repeat_interval`)
- In-memory Map with auto-cleanup of expired entries

## Slack Modes

### Socket Mode (recommended for K8s deployment)
- Set `SLACK_APP_TOKEN=xapp-...`
- Bolt connects WebSocket to Slack (outbound) — no public URL required
- Alertmanager webhook (`/alert`) and health check (`/health`) run on a separate Express server on the same port
- No Ingress/LoadBalancer needed for Slack events

### HTTP Mode
- Do not set `SLACK_APP_TOKEN`
- Slack sends events to a public URL via Events API
- Requires a publicly reachable Ingress/LoadBalancer
- `SLACK_SIGNING_SECRET` is used to verify request authenticity

## Environment Variables
```
SLACK_BOT_TOKEN          # xoxb-... (required)
SLACK_SIGNING_SECRET     # required for HTTP mode
SLACK_APP_TOKEN          # xapp-... for Socket Mode
SLACK_ALERT_CHANNEL      # channel ID for Alertmanager alerts
SLACK_ONCALL_USERS       # comma-separated user IDs, mentioned when confidence is Low

LLM_PROVIDER             # claude | openai-compatible
ANTHROPIC_API_KEY        # required if claude
CLAUDE_MODEL             # default: claude-opus-4-5

MCP_TRANSPORT            # stdio | http
MCP_STDIO_ARGS           # path to MCP server dist/index.js (comma-separated)
MCP_HTTP_URL             # http://devops-mcp-server:3000/mcp

MEMORY_BACKEND           # inmemory | redis
REDIS_HOST/PORT/DB       # if using redis

MAX_CONCURRENT_INVESTIGATIONS  # default: 5
```

## File Structure
```
src/
├── agent/
│   ├── index.ts                  # DevOpsAgent: agentic loop, parallel tool calls
│   ├── confidence/index.ts       # parseConfidence() — regex extracts High/Medium/Low
│   ├── context/index.ts          # trimHistory(), sanitizeContentBlocks(), truncateToolResult()
│   ├── dedup/index.ts            # AlertDeduplicator: fingerprint + TTL
│   ├── llm/
│   │   ├── index.ts              # createLLMClient() factory
│   │   ├── claude.ts             # ClaudeClient: cache_control on system prompt + tools
│   │   ├── openai-compatible.ts  # OpenAICompatibleClient
│   │   └── types.ts              # LLMClient, Message, ContentBlock, TokenUsage
│   ├── mcp/client.ts             # MCPClient: reconnect with mutex
│   ├── memory/index.ts           # ConversationMemory: Redis/in-memory, hasRca/markRcaSent
│   └── prompts/system.ts         # buildStaticSystemPrompt(), buildTimeContext()
├── app/index.ts                  # SlackApp: Bolt + ExpressReceiver, handleMention/handleAlert
├── config/index.ts               # Config object
└── utils/
    ├── logger/index.ts           # Winston logger
    └── slack/blocks.ts           # isRcaResponse(), buildRcaBlocks()
```

## Bugs Fixed
1. **"Already connected to transport"** — MCP server HTTP mode now creates a new McpServer per request
2. **Follow-up always returns RCA format** — inject `[FOLLOW-UP]` prefix + `markRcaSent` Redis flag
3. **Block Kit not rendering** — LLM outputs `[Critical]` with brackets; regex updated to handle both forms
4. **Race condition on reconnect** — `reconnectMutex` added to MCPClient
5. **False positive confidence parsing** — regex anchored to label, no longer matches mid-sentence phrases

## Alertmanager Integration Notes
- `group_by: ["alertname", "namespace"]` — one webhook per alert+namespace combination
- `repeat_interval: 12h` — agent dedup TTL must be >= this (set to 12h)
- Label templating `{{ $labels.pod }}` in the `labels:` block is **not resolved** by Prometheus — only works in `annotations:`
- `startsAt` from Alertmanager payload is included in `issueText` as a unix timestamp for the agent to use as a query anchor

## Potential Improvements
- [ ] `/clear` Slack command to reset thread history
- [ ] Configurable confidence threshold via env var (currently hardcoded to "low")
- [ ] Rate limiting per user/channel
- [ ] Persistent dedup storage (currently in-memory; restarts reset it)
- [ ] Streaming response to Slack (incrementally update message during investigation)
- [ ] Multi-cluster support (one MCP server per cluster, agent selects based on namespace/label)
- [ ] Alert grouping — if 5 pods crash in the same namespace, investigate once not 5 times
- [ ] Webhook authentication for `/alert` endpoint (currently unauthenticated)
