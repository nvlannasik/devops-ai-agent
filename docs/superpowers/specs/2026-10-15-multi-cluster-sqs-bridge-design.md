# Multi-cluster, part 1: the SQS bridge transport — design

Date: 2026-10-15. Sub-project 1 of 3 (**SQS bridge transport** → cluster identity and routing in
the agent → GitOps mapping and deploy).

## Context

The target topology is one observability cluster (Prometheus, Loki, Alertmanager, Tracing — and the
agent) plus one workload cluster per environment. The workload clusters are **outbound-only**:
nothing may connect into them. The observability cluster accepts inbound connections from a
whitelist.

The agent needs Kubernetes access in every workload cluster, for reads (pod state, events,
ReplicaSets for the change timeline, rollout history, dry-runs) as much as for remediation.
Today `devops-mcp-server` reads the cluster it runs in (`loadFromCluster()`), and the agent talks
to exactly one MCP server over HTTP. Neither can reach a cluster that accepts no inbound traffic.

The stack already solved this exact constraint once: llm-worker lives in a private network,
outbound-only, and the agent reaches it through SQS (request queue → shared response queue,
routed by `requestId`). This part applies the same pattern to the MCP tools.

The observability cluster's own MCP server stays on HTTP, as today: it runs beside the agent, so
SQS would add latency and nothing else.

## Goal

`devops-mcp-server` runs in a workload cluster as a **bridge**. It consumes tool calls from an SQS
queue and executes them with that cluster's own ServiceAccount and RBAC. It answers on a response
queue, and makes no inbound connection anywhere. The agent gets an `SqsMCPClient` with the same
interface as `MCPClient`, so everything above it (trace, replay, bench, `instrumentMCP`) is unchanged.

Success:
- `npm run mcp:probe -- lab2 k8s_list_pods '{"namespace":"sample-apps"}'` from the agent repo
  returns live pod data through a bridge deployed in this lab cluster as cluster `lab2`.
- A request whose deadline has passed is never executed.
- A write tool is never executed twice for one request.
- With no bridge configured, nothing in the agent or the MCP server behaves differently.

Out of scope (later parts): which cluster a thread talks to, routing tool calls by cluster, the
PromQL/LogQL cluster guard, `cluster` columns in Postgres, GitOps path mapping, chart and IAM changes
for real workload clusters.

## Components

### 1. The contract (agent ↔ bridge)

A third SQS contract, beside the LLM and GitOps ones. It is recorded in the workspace `CLAUDE.md`
cross-repo contracts, because it binds two repos with no shared module.

The bridge does NOT carry the MCP protocol itself. MCP is session-based (an `initialize`
handshake, a persistent session), and sessions do not survive several agent replicas and several
bridge replicas on one queue. This contract is a stateless RPC over the same tool handlers: any
bridge replica can answer any request.

Request, on `devops-mcp-<cluster>-request.fifo`:
```ts
{ requestId: string; op: "list_tools" | "call_tool"; tool?: string; args?: Record<string, unknown>;
  deadline: number; traceId?: string }
```
- `deadline` is epoch milliseconds: the time after which the agent no longer waits for the answer.
- `MessageGroupId` = `MessageDeduplicationId` = `requestId`. Independent calls run in parallel,
  and SQS drops a duplicate send of the same request within its 5-minute dedup window.

Response, on `devops-mcp-response.fifo`:
```ts
{ requestId: string; response?: { tools: ToolDefinition[] } | { content: string; isError?: boolean };
  error?: string }
```
- `ToolDefinition` is `{ name, description, inputSchema }`, the shape `listTools` returns over MCP today.
- `error` is a transport-level failure: an expired request, an unknown tool, invalid JSON, or args
  failing validation. `isError` is a tool that ran and failed, the same as an MCP `isError` result.

The response queue is dedicated to MCP and shared by every agent replica. It is NOT the LLM
response queue. One investigation makes tens of tool calls, and on a shared queue the LLM, GitOps
and MCP dispatchers would keep receiving and releasing each other's messages
(`releaseVisibilitySeconds`), slowing LLM answers that are already the critical path.

### 2. The bridge — `devops-mcp-server`, `TRANSPORT=sqs`

`TRANSPORT` already selects `stdio` or `http` (`src/app/index.ts`). `sqs` is a third value.
- **Config:**
  - `MCP_SQS_REQUEST_QUEUE` (required in this mode);
  - `MCP_SQS_RESPONSE_QUEUE`;
  - `AWS_REGION`;
  - `MCP_SQS_CONCURRENCY` (default 4);
  - `MCP_SQS_POLL_WAIT_SECONDS` (default 20).
- **One invocation path.** A new `invokeTool(name, args)` holds what the HTTP handler does today:
  - zod validation from `jsonSchemaToZod(tool.inputSchema)`;
  - `withTimeout(tool.handler(args), TOOL_HANDLER_TIMEOUT_MS)`;
  - the same "Tool executed" log line.

  The HTTP handler calls it too, so the two transports cannot drift apart in validation, timeout or
  logging.
- **Consumer loop.** It mirrors llm-worker's `worker.ts`:
  - long poll;
  - a concurrency cap;
  - in-flight bookkeeping;
  - a graceful drain on SIGTERM;
  - a poison guard. A body that does not parse, or has no `requestId`, is deleted and logged. If it
    has a `requestId`, it is also answered with `error`. It is never left to loop.
- **Deadline.** A request whose `deadline` is in the past (allowing 2 s of clock skew) is answered
  `error: "expired"` and never executed. Without this, a `restart` that sat in the queue during a
  bridge outage would run minutes after the agent gave up, and after a human was told it failed.
- **Writes are at-most-once, reads at-least-once.**
  - A `call_tool` for a write tool (membership in `kubernetes/write.ts`'s list) has its message
    deleted **before** the handler runs. A crash mid-call then loses the call; it is never
    repeated. The agent sees a timeout, and the verification poller checks the outcome.
  - A read is deleted after its response is sent, so a crash re-runs it, which is harmless.
  - The receive visibility timeout is `TOOL_HANDLER_TIMEOUT_MS` + 30 s, so a slow read is never
    redelivered to a second bridge replica while the first is still running it.
- **Size cap.** The response body is capped at 240 KB (SQS allows 256 KB). Over that, `content` is
  cut at a UTF-8-safe boundary and ends with
  `\n[truncated by the bridge: <n> of <m> bytes]`, and the log line says so.
- **Write tools** register exactly as today: only under `MCP_ENABLE_WRITE_TOOLS=true`, with
  `ALLOWED_REMEDIATION_NAMESPACES`. A bridge with writes off never lists them, which is how a
  cluster's write policy is set (part 2 reads it from `list_tools`).
- **AWS credentials.** The image gains the same `entrypoint.sh` and `aws_signing_helper` the agent
  uses (`AWS_AUTH_MODE=iam-anywhere|env`), so a workload cluster outside AWS authenticates the
  same way the agent does. `@aws-sdk/client-sqs` is added at the version the agent and worker pin
  (3.1058.0), the only new dependency.
- **Health.** The SQS mode has no HTTP server, so there is no probe endpoint. The pod is healthy
  when its poll loop is alive, and an exec probe checks a heartbeat file the loop touches each
  iteration.

### 3. The agent — `SqsMCPClient`

`src/agent/mcp/sqs-client.ts`, with the public surface of `MCPClient`: `connect()`, `getTools()`,
`callTool(name, input)`, `disconnect()`.
- **Dispatcher.** It mirrors `SqsGitOpsClient`:
  - sends to the cluster's request queue;
  - routes off `devops-mcp-response.fifo` by `requestId`;
  - releases messages it does not own (another replica's) with `releaseVisibilitySeconds`;
  - tombstones expired request ids.

  One dispatcher serves all the bridges, because they share one response queue.
- **`connect()`** sends `list_tools` with a 15 s deadline and caches the definitions.
  - A refresh runs every 5 minutes.
  - A failed refresh keeps the last list and logs `[mcp-sqs] <cluster> unreachable`.
  - A failed first `connect()` leaves the client with no tools and logs it. It does not stop the
    agent from booting: one unreachable cluster must not take down the agent for every other cluster.
- **`callTool`.** The deadline is `now + config.mcp.toolTimeoutMs`. When the deadline passes, it
  throws `bridge <cluster> did not answer within <n>s`. A transport `error` throws with the
  bridge's message. `isError` content returns as text, as `MCPClient` does.

  It **never retries**. `MCPClient` retries once after a reconnect, which is safe for an in-process
  HTTP session. Over SQS a retry is a second request with a new `requestId`, so a write whose
  reply was lost would run twice. The model can still call again: that new call is a decision the
  trace records, not a hidden repeat.
- **Config.** `MCP_SQS_CLUSTERS` is a comma list of `name=requestQueueName`
  (`lab2=devops-mcp-lab2-request.fifo`), plus `MCP_SQS_RESPONSE_QUEUE`. Unset means none: the agent
  is exactly today's. In this part the clients are built only for the probe. Wiring them into
  investigations is part 2.

### 4. The probe

`npm run mcp:probe -- <cluster> [tool] [json-args]`, a small script in the agent repo.
- With no tool, it prints `list_tools`.
- With a tool, it prints the call's result, its duration, and its size.
- It reads the same config as the agent and exits non-zero on any error.
- `--expired` sends a request whose deadline has already passed, for the live check of the
  deadline rule.

It is how this part is proven live, and it stays useful for checking a new cluster's bridge before
pointing investigations at it.

## Error handling

| Condition | Behaviour |
|---|---|
| Bridge down / queue unpolled | the agent's `callTool` throws at the deadline; the request expires unexecuted |
| Request older than its deadline | bridge answers `error: "expired"`, does not execute |
| Bridge crashes during a write | message was already deleted: the write may or may not have happened, never twice; the agent times out |
| Bridge crashes during a read | message redelivered after its visibility timeout, read re-runs |
| Malformed body | deleted; answered with `error` when it has a `requestId`; logged |
| Unknown tool / invalid args | `error` from `invokeTool`'s validation, same text as the HTTP path |
| Result over 240 KB | truncated with a marker; logged |
| `list_tools` fails at boot | that cluster has no tools; logged; agent boots |

## Testing

- **Bridge (fake SQS client):**
  - `list_tools` returns every registered tool, and write tools only when enabled;
  - `call_tool` validates args through `invokeTool`;
  - an expired deadline is answered and the handler is never called;
  - a write's delete happens before its handler runs, and a read's after its response is sent;
  - a 300 KB result is capped with the marker;
  - a poison body is deleted and does not throw out of the loop;
  - the HTTP path still validates and times out through `invokeTool` (the existing tests keep passing).
- **Agent (fake SQS client):**
  - a routed response resolves the right waiter;
  - a deadline miss throws the bridge timeout message;
  - an `error` response throws;
  - there is no retry, so exactly one send per `callTool`;
  - a non-owned message is released;
  - `MCP_SQS_CLUSTERS` parsing, including unset meaning none.
- **Contract:** one test per side pins the request and response shapes against a shared literal,
  the way the worker contract is pinned.
- **Live:**
  - a bridge Deployment in this cluster (`devops-tools`, read-only SA, its own request queue)
    registered as `lab2`;
  - `mcp:probe` lists its tools and runs `k8s_list_pods` against `sample-apps`;
  - stopping the bridge, then probing, gives the timeout;
  - `mcp:probe --expired` is answered `expired`.

## Docs

- Workspace `CLAUDE.md`: the agent ↔ bridge contract in the cross-repo contracts section.
- `devops-mcp-server/CLAUDE.md`: the `TRANSPORT=sqs` mode, at-most-once writes, the deadline rule,
  and the size cap.
- `devops-ai-agent/CLAUDE.md`: a gotcha bullet covering:
  - `SqsMCPClient` never retries;
  - the response queue is dedicated, not the LLM one;
  - an unreachable cluster never blocks boot.
