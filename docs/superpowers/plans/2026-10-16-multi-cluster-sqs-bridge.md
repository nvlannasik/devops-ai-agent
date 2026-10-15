# Multi-cluster part 1: SQS bridge transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kubernetes tool calls reach an outbound-only cluster through SQS. `devops-mcp-server` gets a `TRANSPORT=sqs` bridge mode, and `devops-ai-agent` gets an `SqsMCPClient` and an `mcp:probe` CLI. A live `lab2` bridge in this cluster proves the path.

**Architecture:**
- **One invocation path.** Tool execution in the MCP server moves into `invokeTool`, which runs validation, the timeout and logging. The HTTP and SQS transports both call it.
- **Bridge core.** `handleBridgeMessage` is pure, with injected reply/remove/now. It applies the contract's rules:
  - poison guard;
  - the deadline;
  - at-most-once writes;
  - the size cap.

  A thin poll loop wraps it, mirroring llm-worker's `pollLoop`.
- **Agent dispatcher.** In the agent, one `SqsMcpDispatcher` per process owns the dedicated MCP response queue. One `SqsMCPClient` per cluster wraps it with the `MCPClient` surface. It never retries.

**Tech Stack:** TypeScript ESM, Node 24, `node:test` + tsx, `@aws-sdk/client-sqs` 3.1058.0, zod 3, `@modelcontextprotocol/sdk` 1.29.

**Spec:** `devops-ai-agent/docs/superpowers/specs/2026-10-15-multi-cluster-sqs-bridge-design.md`

## Global Constraints

- **Repos.**
  - `devops-mcp-server` and `devops-ai-agent`, plus a contract bullet in the workspace `CLAUDE.md`.
  - **No chart, GitOps or IAM changes** (part 3).
  - `npm test`, `npx tsc --noEmit` and `npm run build` pass in both repos.
- **Dependencies:** the only new one is `@aws-sdk/client-sqs` at exactly `3.1058.0`, in `devops-mcp-server`. The agent and worker already pin that version.
- **Contract shapes, verbatim from the spec.**
  - Request: `{ requestId, op: "list_tools" | "call_tool", tool?, args?, deadline, traceId? }`, where `deadline` is epoch ms.
  - Response: `{ requestId, response?: { tools } | { content, isError? }, error? }`.
  - `MessageGroupId` = `MessageDeduplicationId` = `requestId` on requests; replies use the same values.
- **Queue names.**
  - Request: `devops-mcp-<cluster>-request.fifo`.
  - Response: `devops-mcp-response.fifo`. It is dedicated to MCP and is never the LLM response queue.
- **Bridge numbers.**
  - Clock skew allowance: 2 s.
  - Response cap: 240 KB, measured on the serialized body.
  - Receive visibility: `TOOL_HANDLER_TIMEOUT_MS / 1000 + 30` s.
  - Concurrency: 4.
  - Poll wait: 20 s.
- **Agent numbers.**
  - `list_tools` timeout: 15 s.
  - Refresh: every 5 min.
  - `call_tool` wait: `config.mcp.toolTimeoutMs`.
- **No behaviour change by default.** With `TRANSPORT` unset or `http`, and `MCP_SQS_CLUSTERS` unset, both services behave exactly as today. In particular, the HTTP-mode mcp-server pod has **no AWS env** and must keep starting.
- **Writes are at-most-once:** the message is deleted before the handler runs. `SqsMCPClient` never retries.
- **Docker.** Builder stages keep `npm ci --ignore-scripts`. The image base stays `node:24-alpine`, with `gcompat openssl` added for `aws_signing_helper`.
- **Process.**
  - Docs are written in English.
  - Commit after each task. **Do not push until Task 6**: a push builds `:latest`, and any pod restart pulls it.
  - Never print secrets.
  - Don't stage `.serena/`.

## Review Focus

1. **The existing HTTP mcp-server pod has no AWS env vars.** The new `entrypoint.sh` must not fail it. The test is in Task 3: `TRANSPORT=http` with no AWS env execs the command.
2. **Bridge args validate exactly as HTTP args do.** A string where an array is expected (`filter: ""`) is absorbed into `[]` on both paths. The test is in Task 1.
3. **JSON escaping can multiply a body's size.** Content full of control characters or emoji grows when serialized, so the cap must measure the serialized bytes. The test is in Task 2.
4. **A write whose reply send fails after the delete.** The handler ran exactly once, and nothing re-runs it. The test is in Task 2.
5. **A bridge reply that arrives after the agent stopped waiting.** It is deleted as the agent's own late reply (tombstone), never released to loop. The test is in Task 4.

---

### Task 1: `invokeTool` — one invocation path for every transport (devops-mcp-server)

**Files:**
- Create: `devops-mcp-server/src/app/invoke.ts`
- Modify: `devops-mcp-server/src/app/index.ts`:
  - move `jsonSchemaToZod` and `TOOL_HANDLER_TIMEOUT_MS` out, with a re-export;
  - `_registerToolsOn` calls `invokeTool`.
- Test: `devops-mcp-server/src/app/invoke.test.ts`

**Interfaces:**
- Produces:
  - `TOOL_HANDLER_TIMEOUT_MS: number`
  - `jsonSchemaToZod(schema)`, unchanged and still re-exported from `./index.js` for `schema.test.ts`
  - `interface ToolOutcome { text: string; isError: boolean }`
  - `invokeTool(tool: Tool, rawArgs: unknown, correlationId?: string): Promise<ToolOutcome>`

- [ ] **Step 1: Write the failing test** — `src/app/invoke.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeTool } from "./invoke.js";
import type { Tool } from "../tools/types.js";

function tool(handler: (input: unknown) => Promise<unknown>): Tool {
  return {
    name: "t_probe",
    description: "test tool",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string" }, filter: { type: "array", items: { type: "string" } } },
      required: ["namespace"],
    },
    handler,
  };
}

test("valid args reach the handler parsed, and the result is its JSON", async () => {
  let seen: unknown;
  const out = await invokeTool(tool(async (i) => { seen = i; return { pods: 2 }; }), { namespace: "sample-apps" });
  assert.deepEqual(seen, { namespace: "sample-apps" });
  assert.deepEqual(out, { text: '{"pods":2}', isError: false });
});

test("a string where an array is expected is absorbed the way the HTTP path absorbs it", async () => {
  let seen: any;
  await invokeTool(tool(async (i) => { seen = i; return 1; }), { namespace: "x", filter: "" });
  assert.deepEqual(seen.filter, []);
});

test("invalid args never reach the handler", async () => {
  let called = false;
  const out = await invokeTool(tool(async () => { called = true; return 1; }), { filter: ["a"] });
  assert.equal(called, false);
  assert.equal(out.isError, true);
  assert.match(out.text, /^Error: invalid arguments for t_probe: namespace/);
});

test("a handler that throws is an isError outcome, not an exception", async () => {
  const out = await invokeTool(tool(async () => { throw new Error("boom"); }), { namespace: "x" });
  assert.deepEqual(out, { text: "Error: boom", isError: true });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd devops-mcp-server && npx tsx --test src/app/invoke.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./invoke.js`.

- [ ] **Step 3: Implement** — create `src/app/invoke.ts`

Move `jsonSchemaToZod`, its `PropSchema`/`InputSchema` types and its comments out of `index.ts` verbatim (export `jsonSchemaToZod` and `InputSchema`). Then add:

```ts
import crypto from "crypto";
import { z, type ZodTypeAny } from "zod";
import { logWithContext } from "../utils/logger/log.js";
import config from "../config/index.js";
import { withTimeout } from "../utils/timeout/index.js";
import { UpstreamError, ValidationError } from "../utils/errors/index.js";
import type { Tool } from "../tools/types.js";

// hard ceiling per tool call — sits just above the upstream HTTP/K8s timeouts so
// their specific errors surface first, but still bounds anything that ignores them
export const TOOL_HANDLER_TIMEOUT_MS = config.upstreamTimeoutMs + 5000;

// … PropSchema, InputSchema, jsonSchemaToZod moved here verbatim …

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

/**
 * The one place a tool runs, for every transport — validation, the timeout, the log lines.
 * Over HTTP the MCP SDK has already validated against the same shape (re-validating is a
 * no-op there); over SQS nothing has, so this is what stands between a queue message and a
 * handler. Two transports with two copies of this logic would drift the first time either
 * changed.
 */
export async function invokeTool(tool: Tool, rawArgs: unknown, correlationId?: string): Promise<ToolOutcome> {
  const start = Date.now();
  const cid = correlationId ?? crypto.randomUUID();

  const parsed = z.object(jsonSchemaToZod(tool.inputSchema as InputSchema)).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
    logWithContext("warn", `Tool input rejected: ${tool.name}`, { correlationId: cid, toolName: tool.name, error: msg });
    return { text: `Error: invalid arguments for ${tool.name}: ${msg}`, isError: true };
  }
  const args = parsed.data;
  const inputStr = JSON.stringify(args).slice(0, 200);
  logWithContext("debug", `Tool called: ${tool.name}`, { correlationId: cid, toolName: tool.name, input: inputStr });

  try {
    const result = await withTimeout(tool.handler(args), TOOL_HANDLER_TIMEOUT_MS, `tool ${tool.name}`);
    const duration = Date.now() - start;
    const resultStr = JSON.stringify(result);
    const resultSize = Buffer.byteLength(resultStr, "utf8");
    logWithContext("info", `Tool executed: ${tool.name}`, {
      correlationId: cid,
      toolName: tool.name,
      status: "ok",
      duration,
      resultSize: `${(resultSize / 1024).toFixed(2)}KB`,
    });
    return { text: resultStr, isError: false };
  } catch (err) {
    const duration = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Expected operational failures (upstream down, pod not found, bad input) log as
    // one line — a stack of wrapper frames adds nothing. Unexpected errors keep the
    // stack: those are the actual bugs.
    const expected = err instanceof UpstreamError || err instanceof ValidationError;
    logWithContext("error", `Tool failed: ${tool.name}`, {
      correlationId: cid,
      toolName: tool.name,
      status: "error",
      duration,
      // the args are logged at debug only, so in prod (info) a failure used to
      // arrive with no way to tell WHICH call broke — repeat them on the error path
      input: inputStr,
      error: errorMsg,
      ...(expected ? {} : { stack: err instanceof Error ? err.stack : undefined }),
    });
    return { text: `Error: ${errorMsg}`, isError: true };
  }
}
```

In `src/app/index.ts`:
- delete the moved code and the now-unused imports (`z`, `ZodTypeAny`, `withTimeout`, the error classes, if nothing else uses them);
- add `import { invokeTool, jsonSchemaToZod, type InputSchema } from "./invoke.js";` and `export { jsonSchemaToZod } from "./invoke.js";`;
- replace `_registerToolsOn`'s body with:

```ts
  private _registerToolsOn(server: McpServer, correlationId?: string): void {
    for (const tool of allTools) {
      const shape = jsonSchemaToZod(tool.inputSchema as InputSchema);
      server.tool(tool.name, tool.description, shape, async (args) => {
        const { text, isError } = await invokeTool(tool, args, correlationId);
        return isError
          ? { content: [{ type: "text" as const, text }], isError: true }
          : { content: [{ type: "text" as const, text }] };
      });
    }
  }
```

- [ ] **Step 4: Run tests, the full suite and tsc**

Run: `cd devops-mcp-server && npx tsx --test src/app/invoke.test.ts src/app/schema.test.ts && npm test > /tmp/claude-1000/mcp-test-t1.log 2>&1; tail -6 /tmp/claude-1000/mcp-test-t1.log; npx tsc --noEmit && echo TSC_OK`
Expected: all pass, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-mcp-server && git add src/app/invoke.ts src/app/invoke.test.ts src/app/index.ts && git commit -m "refactor(app): invokeTool — one invocation path (validation, timeout, logs) for every transport"
```

---

### Task 2: Bridge core — `handleBridgeMessage` (devops-mcp-server)

**Files:**
- Create: `devops-mcp-server/src/app/sqs-bridge.ts`
- Test: `devops-mcp-server/src/app/sqs-bridge.test.ts`

**Interfaces:**
- Consumes: `invokeTool`, `ToolOutcome` (Task 1); `Tool` (`src/tools/types.ts`).
- Produces:
  - `CLOCK_SKEW_MS = 2000`, `MAX_RESPONSE_BYTES = 240 * 1024`
  - `interface BridgeRequest { requestId: string; op: "list_tools" | "call_tool"; tool?: string; args?: Record<string, unknown>; deadline: number; traceId?: string }`
  - `parseBridgeRequest(body: string | undefined): { request: BridgeRequest } | { requestId?: string; error: string }`
  - `fitResponse(requestId: string, content: string, isError: boolean): { body: string; truncatedFrom?: number }`
  - `interface BridgeDeps { tools: Tool[]; writeToolNames: ReadonlySet<string>; invoke: (tool: Tool, args: unknown, cid?: string) => Promise<ToolOutcome>; reply: (requestId: string, body: string) => Promise<void>; remove: () => Promise<void>; now: () => number }`
  - `handleBridgeMessage(body: string | undefined, deps: BridgeDeps): Promise<void>`

- [ ] **Step 1: Write the failing tests** — `src/app/sqs-bridge.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBridgeMessage, parseBridgeRequest, fitResponse, MAX_RESPONSE_BYTES, type BridgeDeps } from "./sqs-bridge.js";
import type { Tool } from "../tools/types.js";

const NOW = 1_760_000_000_000;
const readTool: Tool = { name: "k8s_list_pods", description: "list", inputSchema: { type: "object", properties: {} }, handler: async () => [] };
const writeTool: Tool = { name: "k8s_restart_deployment", description: "restart", inputSchema: { type: "object", properties: {} }, handler: async () => ({ ok: true }) };

// The literal pinned on BOTH sides of the contract (the agent's sqs-client.test.ts holds the same keys).
const CONTRACT_REQUEST = { requestId: "r-1", op: "call_tool", tool: "k8s_list_pods", args: { namespace: "sample-apps" }, deadline: NOW + 30_000, traceId: "1791903072.183579" };

function harness(over: Partial<BridgeDeps> = {}) {
  const events: string[] = [];
  const replies: Array<{ requestId: string; body: any }> = [];
  const deps: BridgeDeps = {
    tools: [readTool, writeTool],
    writeToolNames: new Set([writeTool.name]),
    invoke: async (t) => { events.push(`invoke:${t.name}`); return { text: '"ok"', isError: false }; },
    reply: async (requestId, body) => { events.push("reply"); replies.push({ requestId, body: JSON.parse(body) }); },
    remove: async () => { events.push("remove"); },
    now: () => NOW,
    ...over,
  };
  return { deps, events, replies };
}

test("contract: the pinned request parses, and a call_tool reply carries content", async () => {
  const p = parseBridgeRequest(JSON.stringify(CONTRACT_REQUEST));
  assert.ok("request" in p);
  const h = harness();
  await handleBridgeMessage(JSON.stringify(CONTRACT_REQUEST), h.deps);
  assert.deepEqual(h.replies[0], { requestId: "r-1", body: { requestId: "r-1", response: { content: '"ok"', isError: false } } });
});

test("list_tools lists the registered tools — write tools only if they were registered", async () => {
  const h = harness({ tools: [readTool] });
  await handleBridgeMessage(JSON.stringify({ requestId: "r-2", op: "list_tools", deadline: NOW + 1000 }), h.deps);
  assert.deepEqual(h.replies[0].body.response.tools.map((t: any) => t.name), ["k8s_list_pods"]);
  assert.deepEqual(Object.keys(h.replies[0].body.response.tools[0]).sort(), ["description", "inputSchema", "name"]);
});

test("an expired request is answered and never executed; inside the 2s skew it still runs", async () => {
  const late = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, deadline: NOW - 3000 }), late.deps);
  assert.deepEqual(late.replies[0].body, { requestId: "r-1", error: "expired" });
  assert.ok(!late.events.some((e) => e.startsWith("invoke")));
  assert.ok(late.events.includes("remove"));
  const skewed = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, deadline: NOW - 1000 }), skewed.deps);
  assert.ok(skewed.events.includes("invoke:k8s_list_pods"));
});

test("a write is removed BEFORE it runs (at-most-once); a read after its reply (at-least-once)", async () => {
  const w = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, tool: "k8s_restart_deployment" }), w.deps);
  assert.deepEqual(w.events, ["remove", "invoke:k8s_restart_deployment", "reply"]);
  const r = harness();
  await handleBridgeMessage(JSON.stringify(CONTRACT_REQUEST), r.deps);
  assert.deepEqual(r.events, ["invoke:k8s_list_pods", "reply", "remove"]);
});

test("a write whose reply send fails ran exactly once and is not left to redeliver", async () => {
  const h = harness({ reply: async () => { throw new Error("send failed"); } });
  await assert.rejects(handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, tool: "k8s_restart_deployment" }), h.deps));
  assert.deepEqual(h.events, ["remove", "invoke:k8s_restart_deployment"]);
});

test("poison: unparseable is removed silently; a parseable body with a requestId but a bad shape is answered", async () => {
  const junk = harness();
  await handleBridgeMessage("{not json", junk.deps);
  assert.deepEqual(junk.events, ["remove"]);
  const bad = harness();
  await handleBridgeMessage(JSON.stringify({ requestId: "r-3", op: "drop_tables", deadline: NOW + 1000 }), bad.deps);
  assert.equal(bad.replies[0].body.requestId, "r-3");
  assert.match(bad.replies[0].body.error, /op/);
  assert.ok(bad.events.includes("remove"));
});

test("an unknown tool is a transport error, not a crash", async () => {
  const h = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, tool: "k8s_nope" }), h.deps);
  assert.deepEqual(h.replies[0].body, { requestId: "r-1", error: "unknown tool: k8s_nope" });
});

test("the cap measures the SERIALIZED body: control chars and emoji expand under JSON escaping", () => {
  for (const unit of ["\u0001", "🔥", "a"]) {
    const content = unit.repeat(200_000);
    const { body, truncatedFrom } = fitResponse("r-1", content, false);
    assert.ok(Buffer.byteLength(body, "utf8") <= MAX_RESPONSE_BYTES, `${JSON.stringify(unit)}: ${Buffer.byteLength(body)}`);
    assert.ok(truncatedFrom && truncatedFrom > 0);
    const parsed = JSON.parse(body);
    assert.match(parsed.response.content, /\n\[truncated by the bridge: \d+ of \d+ bytes\]$/);
    assert.doesNotMatch(parsed.response.content, /[\ud800-\udbff](?![\udc00-\udfff])/, "no lone high surrogate at the cut");
  }
  const small = fitResponse("r-1", "fine", true);
  assert.equal(small.truncatedFrom, undefined);
  assert.deepEqual(JSON.parse(small.body), { requestId: "r-1", response: { content: "fine", isError: true } });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-mcp-server && npx tsx --test src/app/sqs-bridge.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./sqs-bridge.js`.

- [ ] **Step 3: Implement** — `src/app/sqs-bridge.ts`

```ts
// The SQS bridge's per-message rules (spec 2026-10-15-multi-cluster-sqs-bridge-design §2). Pure
// apart from the injected deps, so every rule is testable without SQS: the poll loop around it
// (sqs-loop.ts) only receives, and calls this once per message.
import { logWithContext } from "../utils/logger/log.js";
import type { Tool } from "../tools/types.js";
import type { ToolOutcome } from "./invoke.js";

export const CLOCK_SKEW_MS = 2000;
// SQS allows 256 KB; the margin is for the envelope fields and SQS's own accounting.
export const MAX_RESPONSE_BYTES = 240 * 1024;

export interface BridgeRequest {
  requestId: string;
  op: "list_tools" | "call_tool";
  tool?: string;
  args?: Record<string, unknown>;
  deadline: number;
  traceId?: string;
}

export interface BridgeDeps {
  tools: Tool[];
  writeToolNames: ReadonlySet<string>;
  invoke: (tool: Tool, args: unknown, cid?: string) => Promise<ToolOutcome>;
  reply: (requestId: string, body: string) => Promise<void>;
  remove: () => Promise<void>;
  now: () => number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseBridgeRequest(body: string | undefined): { request: BridgeRequest } | { requestId?: string; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    return { error: "body is not JSON" };
  }
  if (!isObj(raw) || typeof raw.requestId !== "string" || !raw.requestId) return { error: "no requestId" };
  const requestId = raw.requestId;
  if (raw.op !== "list_tools" && raw.op !== "call_tool") return { requestId, error: `bad op: ${String(raw.op)}` };
  if (typeof raw.deadline !== "number" || !Number.isFinite(raw.deadline)) return { requestId, error: "bad deadline" };
  if (raw.op === "call_tool" && (typeof raw.tool !== "string" || !raw.tool)) return { requestId, error: "call_tool needs a tool" };
  if (raw.args !== undefined && !isObj(raw.args)) return { requestId, error: "args must be an object" };
  if (raw.traceId !== undefined && typeof raw.traceId !== "string") return { requestId, error: "bad traceId" };
  return {
    request: {
      requestId,
      op: raw.op,
      tool: raw.tool as string | undefined,
      args: raw.args as Record<string, unknown> | undefined,
      deadline: raw.deadline,
      traceId: raw.traceId as string | undefined,
    },
  };
}

/**
 * The reply body, cut to fit SQS. Measured on the SERIALIZED body, never on `content`:
 * JSON escaping turns one control character into six bytes, so a cap on content length
 * still overflows. The cut never splits a surrogate pair.
 */
export function fitResponse(requestId: string, content: string, isError: boolean): { body: string; truncatedFrom?: number } {
  const whole = JSON.stringify({ requestId, response: { content, isError } });
  if (Buffer.byteLength(whole, "utf8") <= MAX_RESPONSE_BYTES) return { body: whole };
  const total = Buffer.byteLength(content, "utf8");
  let keep = content.length;
  for (;;) {
    keep = Math.floor(keep * 0.8);
    let cut = content.slice(0, keep);
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    const marked = `${cut}\n[truncated by the bridge: ${Buffer.byteLength(cut, "utf8")} of ${total} bytes]`;
    const body = JSON.stringify({ requestId, response: { content: marked, isError } });
    if (Buffer.byteLength(body, "utf8") <= MAX_RESPONSE_BYTES) return { body, truncatedFrom: total };
  }
}

export async function handleBridgeMessage(body: string | undefined, deps: BridgeDeps): Promise<void> {
  const parsed = parseBridgeRequest(body);
  if ("error" in parsed) {
    logWithContext("warn", `Bridge: unusable request — ${parsed.error}`, { requestId: parsed.requestId });
    if (parsed.requestId) await deps.reply(parsed.requestId, JSON.stringify({ requestId: parsed.requestId, error: parsed.error }));
    await deps.remove();
    return;
  }
  const req = parsed.request;

  // A request the agent stopped waiting for is never executed: a restart that sat in the queue
  // through a bridge outage must not run minutes after a human was told it failed. The same
  // rule bounds a poison read: its redelivery (after the visibility timeout) is already expired.
  if (deps.now() > req.deadline + CLOCK_SKEW_MS) {
    logWithContext("warn", `Bridge: expired request ${req.requestId} (${req.op} ${req.tool ?? ""})`, { requestId: req.requestId });
    await deps.reply(req.requestId, JSON.stringify({ requestId: req.requestId, error: "expired" }));
    await deps.remove();
    return;
  }

  if (req.op === "list_tools") {
    const tools = deps.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    await deps.reply(req.requestId, JSON.stringify({ requestId: req.requestId, response: { tools } }));
    await deps.remove();
    return;
  }

  const tool = deps.tools.find((t) => t.name === req.tool);
  if (!tool) {
    await deps.reply(req.requestId, JSON.stringify({ requestId: req.requestId, error: `unknown tool: ${req.tool}` }));
    await deps.remove();
    return;
  }

  // At-most-once for writes: deleted BEFORE it runs, so a crash mid-call loses the call rather
  // than repeating it. A read is deleted after its reply, so a crash re-runs it — harmless.
  const isWrite = deps.writeToolNames.has(tool.name);
  if (isWrite) await deps.remove();
  const outcome = await deps.invoke(tool, req.args ?? {}, req.traceId ?? req.requestId);
  const { body: out, truncatedFrom } = fitResponse(req.requestId, outcome.text, outcome.isError);
  if (truncatedFrom) {
    logWithContext("warn", `Bridge: ${tool.name} result truncated to fit SQS (${truncatedFrom} bytes)`, { requestId: req.requestId });
  }
  await deps.reply(req.requestId, out);
  if (!isWrite) await deps.remove();
}
```

- [ ] **Step 4: Run the tests, the full suite and tsc**

Run: `cd devops-mcp-server && npx tsx --test src/app/sqs-bridge.test.ts && npm test > /tmp/claude-1000/mcp-test-t2.log 2>&1; tail -6 /tmp/claude-1000/mcp-test-t2.log; npx tsc --noEmit && echo TSC_OK`
Expected: 8/8 pass, the suite green, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-mcp-server && git add src/app/sqs-bridge.ts src/app/sqs-bridge.test.ts && git commit -m "feat(bridge): per-message rules — deadline, at-most-once writes, size cap, poison guard"
```

---

### Task 3: Bridge runtime — poll loop, `TRANSPORT=sqs`, image (devops-mcp-server)

**Files:**
- Create: `devops-mcp-server/src/app/sqs-loop.ts`, `devops-mcp-server/entrypoint.sh`
- Modify:
  - `devops-mcp-server/src/config/index.ts` (add `sqs`);
  - `devops-mcp-server/src/app/index.ts` (`start()`/`stop()`);
  - `devops-mcp-server/package.json` (dependency);
  - `devops-mcp-server/Dockerfile`;
  - `devops-mcp-server/CLAUDE.md`.
- Test: `devops-mcp-server/src/app/sqs-loop.test.ts`, `devops-mcp-server/src/app/entrypoint.test.ts`

**Interfaces:**
- Consumes: `handleBridgeMessage` (Task 2); `invokeTool`, `TOOL_HANDLER_TIMEOUT_MS` (Task 1); `allTools` (`src/tools/index.ts`); `writeTools` (`src/tools/kubernetes/write.ts`, default export, always the full list).
- Produces:
  - `interface PollDeps { sqs: { send(cmd: unknown, opts?: unknown): Promise<any> }; requestUrl: string; concurrency: number; pollWaitSeconds: number; visibilitySeconds: number; heartbeat: () => Promise<void>; handle: (body: string | undefined, receiptHandle: string) => Promise<void> }`
  - `pollRequests(signal: AbortSignal, d: PollDeps): Promise<void>`
  - `startSqsBridge(signal: AbortSignal): Promise<void>`
  - `config.sqs = { region, requestQueueName, responseQueueName, concurrency, pollWaitSeconds, heartbeatFile }`

- [ ] **Step 1: Add the dependency**

Run: `cd devops-mcp-server && npm install --save-exact @aws-sdk/client-sqs@3.1058.0`
Expected: `package.json` has `"@aws-sdk/client-sqs": "3.1058.0"` and the lockfile is updated.

- [ ] **Step 2: Write the failing tests**

`src/app/sqs-loop.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pollRequests } from "./sqs-loop.js";

test("one receive: each message handled with its body and receipt handle, heartbeat touched, abort stops the loop", async () => {
  const ac = new AbortController();
  const handled: Array<[string | undefined, string]> = [];
  let beats = 0;
  let receives = 0;
  const receiveInputs: any[] = [];
  const sqs = {
    send: async (cmd: any) => {
      if (cmd.constructor.name !== "ReceiveMessageCommand") throw new Error(`unexpected ${cmd.constructor.name}`);
      receives++;
      receiveInputs.push(cmd.input);
      if (receives === 1) return { Messages: [{ Body: '{"a":1}', ReceiptHandle: "rh-1" }, { Body: '{"b":2}', ReceiptHandle: "rh-2" }] };
      ac.abort();
      return { Messages: [] };
    },
  };
  await pollRequests(ac.signal, {
    sqs, requestUrl: "https://q/req", concurrency: 4, pollWaitSeconds: 1, visibilitySeconds: 65,
    heartbeat: async () => { beats++; },
    handle: async (body, rh) => { handled.push([body, rh]); },
  });
  assert.deepEqual(handled, [['{"a":1}', "rh-1"], ['{"b":2}', "rh-2"]]);
  assert.ok(beats >= 1);
  assert.equal(receiveInputs[0].VisibilityTimeout, 65, "a slow read is never redelivered mid-run");
  assert.equal(receiveInputs[0].QueueUrl, "https://q/req");
});

test("a handler that throws does not stop the loop", async () => {
  const ac = new AbortController();
  let receives = 0;
  const sqs = {
    send: async () => {
      receives++;
      if (receives === 1) return { Messages: [{ Body: "x", ReceiptHandle: "rh" }] };
      ac.abort();
      return { Messages: [] };
    },
  };
  await pollRequests(ac.signal, {
    sqs, requestUrl: "u", concurrency: 1, pollWaitSeconds: 1, visibilitySeconds: 65,
    heartbeat: async () => {},
    handle: async () => { throw new Error("handler blew up"); },
  });
  assert.ok(receives >= 2);
});
```

`src/app/entrypoint.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = fileURLToPath(new URL("../../entrypoint.sh", import.meta.url));
const run = (env: Record<string, string>) =>
  spawnSync("sh", [ENTRYPOINT, "echo", "RAN"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" });

// The HTTP-mode server has never had AWS env — the agent's entrypoint, copied as-is, defaults to
// iam-anywhere and would refuse to start every existing mcp-server pod.
test("HTTP mode with no AWS env starts the command and sets up no credentials", () => {
  const r = run({ TRANSPORT: "http" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RAN/);
  assert.match(r.stdout, /skipping credential setup/);
});

test("SQS mode defaults to iam-anywhere and refuses to start without its env", () => {
  const r = run({ TRANSPORT: "sqs" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /AWS_TRUST_ANCHOR_ARN/);
});

test("an explicit AWS_AUTH_MODE=env is honoured in SQS mode", () => {
  const r = run({ TRANSPORT: "sqs", AWS_AUTH_MODE: "env" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RAN/);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd devops-mcp-server && npx tsx --test src/app/sqs-loop.test.ts src/app/entrypoint.test.ts`
Expected: FAIL. `./sqs-loop.js` is not found, and `entrypoint.sh` is missing (status non-zero).

- [ ] **Step 4: Implement**

`entrypoint.sh`: copy `devops-ai-agent/entrypoint.sh` byte for byte, then change exactly one line. Replace `AWS_AUTH_MODE="${AWS_AUTH_MODE:-iam-anywhere}"` with:

```sh
# Only the SQS bridge talks to AWS. The HTTP server has never had AWS env, so it must not
# default to iam-anywhere (which refuses to start without the role/anchor env).
if [ "${TRANSPORT:-http}" = "sqs" ]; then
  AWS_AUTH_MODE="${AWS_AUTH_MODE:-iam-anywhere}"
else
  AWS_AUTH_MODE="${AWS_AUTH_MODE:-none}"
fi
```

Also update the header comment's mode list to mention `none (default unless TRANSPORT=sqs)`.

`src/config/index.ts` — add inside `config`:

```ts
  // TRANSPORT=sqs: the bridge for a cluster that accepts no inbound traffic (spec
  // 2026-10-15-multi-cluster-sqs-bridge-design). Unused in http/stdio mode.
  sqs: {
    region: process.env.AWS_REGION ?? "ap-southeast-1",
    requestQueueName: process.env.MCP_SQS_REQUEST_QUEUE ?? "",
    responseQueueName: process.env.MCP_SQS_RESPONSE_QUEUE ?? "devops-mcp-response.fifo",
    concurrency: parseInt(process.env.MCP_SQS_CONCURRENCY ?? "4"),
    pollWaitSeconds: parseInt(process.env.MCP_SQS_POLL_WAIT_SECONDS ?? "20"),
    // touched every poll iteration; the pod's exec probe checks its age (no HTTP server here)
    heartbeatFile: process.env.MCP_SQS_HEARTBEAT_FILE ?? "/tmp/bridge-heartbeat",
  },
```

`src/app/sqs-loop.ts`:

```ts
// The SQS bridge's receive loop and its wiring (TRANSPORT=sqs). Mirrors llm-worker's pollLoop:
// long poll, a concurrency cap, in-flight bookkeeping, a drain on abort. Every per-message
// rule lives in sqs-bridge.ts.
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  GetQueueUrlCommand,
  CreateQueueCommand,
  QueueDoesNotExist,
} from "@aws-sdk/client-sqs";
import { writeFile } from "fs/promises";
import { logWithContext } from "../utils/logger/log.js";
import config from "../config/index.js";
import allTools from "../tools/index.js";
import writeTools from "../tools/kubernetes/write.js";
import { invokeTool, TOOL_HANDLER_TIMEOUT_MS } from "./invoke.js";
import { handleBridgeMessage } from "./sqs-bridge.js";

export interface PollDeps {
  sqs: { send(cmd: unknown, opts?: unknown): Promise<any> };
  requestUrl: string;
  concurrency: number;
  pollWaitSeconds: number;
  visibilitySeconds: number;
  heartbeat: () => Promise<void>;
  handle: (body: string | undefined, receiptHandle: string) => Promise<void>;
}

export async function pollRequests(signal: AbortSignal, d: PollDeps): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  while (!signal.aborted) {
    await d.heartbeat().catch(() => {});
    if (inFlight.size >= d.concurrency) {
      await Promise.race(inFlight);
      continue;
    }
    try {
      const result = await d.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: d.requestUrl,
          MaxNumberOfMessages: Math.min(d.concurrency - inFlight.size, 10), // SQS hard cap is 10
          WaitTimeSeconds: d.pollWaitSeconds,
          // longer than any tool may run, so a slow read is never redelivered to a second
          // bridge replica while the first is still running it
          VisibilityTimeout: d.visibilitySeconds,
        }),
        { abortSignal: signal }
      );
      for (const msg of result.Messages ?? []) {
        const task: Promise<void> = d
          .handle(msg.Body, msg.ReceiptHandle!)
          .catch((err: unknown) => {
            logWithContext("error", `Bridge: handler failed — ${err instanceof Error ? err.message : String(err)}`, {});
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    } catch (err) {
      if (signal.aborted) break;
      logWithContext("error", `Bridge: poll error — retrying in 5s: ${err instanceof Error ? err.message : String(err)}`, {});
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (inFlight.size > 0) {
    logWithContext("info", `Bridge: draining ${inFlight.size} in-flight request(s)`, {});
    await Promise.allSettled(inFlight);
  }
}

async function resolveQueueUrl(sqs: SQSClient, name: string): Promise<string> {
  try {
    return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  } catch (err) {
    if (!(err instanceof QueueDoesNotExist)) throw err;
    logWithContext("warn", `Bridge: queue "${name}" not found — creating`, {});
    const res = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } })
    );
    return res.QueueUrl!;
  }
}

/** TRANSPORT=sqs. Resolves when the loop stops (abort, then drain). */
export async function startSqsBridge(signal: AbortSignal): Promise<void> {
  const c = config.sqs;
  if (!c.requestQueueName) throw new Error("TRANSPORT=sqs needs MCP_SQS_REQUEST_QUEUE");
  const sqs = new SQSClient({
    region: c.region,
    // requestTimeout must exceed the long-poll wait so normal empty receives aren't cut short
    requestHandler: { connectionTimeout: 5000, requestTimeout: (c.pollWaitSeconds + 15) * 1000 },
    maxAttempts: 3,
  });
  const [requestUrl, responseUrl] = await Promise.all([resolveQueueUrl(sqs, c.requestQueueName), resolveQueueUrl(sqs, c.responseQueueName)]);
  const writeToolNames = new Set(writeTools.map((t) => t.name));
  logWithContext("info", "MCP Server started in SQS bridge mode", {
    transport: "sqs",
    requestQueue: c.requestQueueName,
    responseQueue: c.responseQueueName,
    tools: allTools.length,
    writeTools: allTools.filter((t) => writeToolNames.has(t.name)).length,
  });
  await pollRequests(signal, {
    sqs,
    requestUrl,
    concurrency: c.concurrency,
    pollWaitSeconds: c.pollWaitSeconds,
    visibilitySeconds: Math.ceil(TOOL_HANDLER_TIMEOUT_MS / 1000) + 30,
    heartbeat: () => writeFile(c.heartbeatFile, String(Date.now())),
    handle: (body, receiptHandle) =>
      handleBridgeMessage(body, {
        tools: allTools,
        writeToolNames,
        invoke: invokeTool,
        now: Date.now,
        reply: async (requestId, out) => {
          await sqs.send(new SendMessageCommand({ QueueUrl: responseUrl, MessageBody: out, MessageGroupId: requestId, MessageDeduplicationId: requestId }));
        },
        remove: async () => {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: requestUrl, ReceiptHandle: receiptHandle }));
        },
      }),
  });
  sqs.destroy();
}
```

`src/app/index.ts`:
- Add `import { startSqsBridge } from "./sqs-loop.js";`.
- Add two fields: `private bridgeAbort: AbortController | null = null;` and `private bridgeDone: Promise<void> | null = null;`.
- In `start()`:
  - change the in-cluster guard to `if (inCluster && transport !== "http" && transport !== "sqs")`. Set its log field to `required: "http or sqs"`.
  - wrap `await this._checkUpstreams();` in `if (transport !== "sqs")`. A bridge's observability URLs belong to the central server, so probing them from a workload cluster only produces false alarms.
  - dispatch with `if (transport === "http") await this._startHttp(); else if (transport === "sqs") this._startSqs(); else await this._startStdio();`.
- Add:

```ts
  private _startSqs(): void {
    this.bridgeAbort = new AbortController();
    this.bridgeDone = startSqsBridge(this.bridgeAbort.signal).catch((err: unknown) => {
      logWithContext("error", `SQS bridge failed: ${err instanceof Error ? err.message : String(err)}`, {});
      process.exit(1);
    });
  }
```

- In `stop()`, as its first statement, add: `if (this.bridgeAbort) { this.bridgeAbort.abort(); await this.bridgeDone; }`.

`Dockerfile`: mirror `devops-ai-agent/Dockerfile`'s AWS pieces.
- Add an `aws-tools` stage between builder and runtime: `FROM alpine:3.20 AS aws-tools`, `ARG TARGETARCH`, `ARG SIGNING_HELPER_VERSION=1.8.4`, and the same `curl` of `aws_signing_helper` with the arch `case`.
- In runtime:
  - `RUN apk add --no-cache gcompat openssl`;
  - `COPY --from=aws-tools /aws_signing_helper /usr/local/bin/aws_signing_helper`;
  - `RUN /usr/local/bin/aws_signing_helper version`;
  - `COPY entrypoint.sh /entrypoint.sh`, then `RUN chmod +x /entrypoint.sh`;
  - `ENTRYPOINT ["/entrypoint.sh"]` before the existing `CMD`.
- Keep `ENV TRANSPORT=http` and the builder's `npm ci --ignore-scripts`.

`CLAUDE.md`: add one Gotchas bullet:

> **`TRANSPORT=sqs` is the bridge for a cluster with no inbound traffic** (`app/sqs-bridge.ts`, `app/sqs-loop.ts`, spec `devops-ai-agent/docs/superpowers/specs/2026-10-15-multi-cluster-sqs-bridge-design.md`).
> - It consumes `MCP_SQS_REQUEST_QUEUE` and answers on `devops-mcp-response.fifo`, through the same `invokeTool` as HTTP.
> - A request past its `deadline` (+2 s skew) is answered `expired` and never run. The same rule bounds a poison read, because its redelivery is already expired.
> - A write tool's message is deleted BEFORE it runs (at-most-once); a read's after its reply.
> - Replies are capped at 240 KB of serialized body.
> - There is no HTTP server, so health is the heartbeat file.
> - `entrypoint.sh` sets up AWS only when `TRANSPORT=sqs`: the HTTP server has no AWS env.
> - The bridge still registers every tool, but its Prometheus/Loki tools have no upstream in a workload cluster. Part 2 of the spec routes only `k8s_*` to bridges.

- [ ] **Step 5: Run the tests, the full suite, tsc and the build**

Run: `cd devops-mcp-server && npx tsx --test src/app/sqs-loop.test.ts src/app/entrypoint.test.ts && npm test > /tmp/claude-1000/mcp-test-t3.log 2>&1; tail -6 /tmp/claude-1000/mcp-test-t3.log; npx tsc --noEmit && npm run build 2>&1 | tail -2 && echo BUILD_OK`
Expected: 5/5 pass, the suite green, `BUILD_OK`. (No Docker here; the GH build in Task 6 builds the image.)

- [ ] **Step 6: Commit**

```bash
cd devops-mcp-server && git add package.json package-lock.json entrypoint.sh Dockerfile CLAUDE.md src/config/index.ts src/app/index.ts src/app/sqs-loop.ts src/app/sqs-loop.test.ts src/app/entrypoint.test.ts && git commit -m "feat(bridge): TRANSPORT=sqs — poll loop, heartbeat, AWS entrypoint only in SQS mode"
```

---

### Task 4: `SqsMcpDispatcher` + `SqsMCPClient` (devops-ai-agent)

**Files:**
- Create: `devops-ai-agent/src/agent/mcp/sqs-client.ts`
- Modify: `devops-ai-agent/src/config/index.ts` (`parseSqsClusters`, `config.mcp.sqs`)
- Test: `devops-ai-agent/src/agent/mcp/sqs-client.test.ts`

**Interfaces:**
- Consumes:
  - `releaseVisibilitySeconds`, `parseResponseBody` from `src/agent/llm/sqs.ts`;
  - `currentTrace()` from `src/utils/trace/index.ts`;
  - `ToolDefinition` from `src/agent/llm/types.ts`.
- Produces:
  - `parseSqsClusters(raw: string | undefined): Array<{ name: string; requestQueueName: string }>` (exported from `src/config/index.ts`)
  - `config.mcp.sqs = { clusters, responseQueueName }`
  - `type BridgePayload = { tools: ToolDefinition[] } | { content: string; isError?: boolean }`
  - `class SqsMcpDispatcher`:
    - `constructor(responseQueueName: string, sqs?: SqsLike, pollWaitSeconds?: number)`;
    - `request(requestQueueName: string, msg: { op: "list_tools" | "call_tool"; tool?: string; args?: Record<string, unknown> }, timeoutMs: number, label: string, opts?: { deadline?: number }): Promise<BridgePayload>`;
    - `shutdown(): Promise<void>`.
  - `class SqsMCPClient`:
    - `constructor(cluster: string, requestQueueName: string, dispatcher: SqsMcpDispatcher, opts?: { listTimeoutMs?: number; refreshMs?: number; callTimeoutMs?: number })`;
    - `connect()`, `getTools()`, `callTool(name, input)`, `disconnect()`.

- [ ] **Step 1: Write the failing tests** — `src/agent/mcp/sqs-client.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqsMcpDispatcher, SqsMCPClient } from "./sqs-client.js";
import { parseSqsClusters } from "../../config/index.js";

// The same contract keys are pinned in devops-mcp-server/src/app/sqs-bridge.test.ts (CONTRACT_REQUEST).
const CONTRACT_REQUEST_KEYS = ["args", "deadline", "op", "requestId", "tool"]; // + traceId inside an investigation

function fakeSqs(answer: (req: any) => any | null) {
  const sent: any[] = [];
  const released: string[] = [];
  const deleted: string[] = [];
  const inbox: any[] = [];
  return {
    sent, released, deleted, inbox,
    sqs: {
      send: async (cmd: any) => {
        const kind = cmd.constructor.name;
        if (kind === "GetQueueUrlCommand") return { QueueUrl: `https://q/${cmd.input.QueueName}` };
        if (kind === "SendMessageCommand") {
          const body = JSON.parse(cmd.input.MessageBody);
          sent.push({ url: cmd.input.QueueUrl, input: cmd.input, body });
          const a = answer(body);
          if (a) inbox.push({ Body: JSON.stringify(a), ReceiptHandle: `rh-${sent.length}`, Attributes: { ApproximateReceiveCount: "1" } });
          return {};
        }
        if (kind === "ReceiveMessageCommand") {
          await new Promise((r) => setTimeout(r, 5));
          return { Messages: inbox.splice(0) };
        }
        if (kind === "DeleteMessageCommand") { deleted.push(cmd.input.ReceiptHandle); return {}; }
        if (kind === "ChangeMessageVisibilityCommand") { released.push(cmd.input.ReceiptHandle); return {}; }
        return {};
      },
      destroy() {},
    },
  };
}

test("callTool: one send to the cluster's queue, contract shape, the routed content returned", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, response: { content: '[{"name":"web-1"}]', isError: false } }));
  const d = new SqsMcpDispatcher("devops-mcp-response.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "devops-mcp-lab2-request.fifo", d, { callTimeoutMs: 2000 });
  const before = Date.now();
  const out = await c.callTool("k8s_list_pods", { namespace: "sample-apps" });
  assert.equal(out, '[{"name":"web-1"}]');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, "https://q/devops-mcp-lab2-request.fifo");
  assert.deepEqual(Object.keys(f.sent[0].body).filter((k) => k !== "traceId").sort(), CONTRACT_REQUEST_KEYS);
  assert.equal(f.sent[0].body.op, "call_tool");
  assert.ok(f.sent[0].body.deadline >= before + 2000);
  assert.equal(f.sent[0].input.MessageGroupId, f.sent[0].body.requestId);
  assert.equal(f.sent[0].input.MessageDeduplicationId, f.sent[0].body.requestId);
  await d.shutdown();
});

test("no answer: throws the bridge timeout, and never retries", async () => {
  const f = fakeSqs(() => null);
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 50 });
  await assert.rejects(c.callTool("k8s_restart_deployment", { name: "web" }), /bridge lab2 did not answer within 0\.05s/);
  assert.equal(f.sent.length, 1, "a retry over SQS is a second request — a write would run twice");
  await d.shutdown();
});

test("a transport error from the bridge throws with its message", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, error: "expired" }));
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 2000 });
  await assert.rejects(c.callTool("k8s_list_pods", {}), /bridge lab2: expired/);
  await d.shutdown();
});

test("an isError result returns as text, the way MCPClient returns it", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, response: { content: "Error: pods is forbidden", isError: true } }));
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 2000 });
  assert.equal(await c.callTool("k8s_list_pods", {}), "Error: pods is forbidden");
  await d.shutdown();
});

test("a message for another replica is released; a late reply to our own timed-out request is deleted", async () => {
  const f = fakeSqs(() => null);
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 30 });
  await assert.rejects(c.callTool("k8s_list_pods", {}));
  const ours = f.sent[0].body.requestId;
  f.inbox.push({ Body: JSON.stringify({ requestId: "someone-else", response: { content: "x" } }), ReceiptHandle: "rh-other", Attributes: { ApproximateReceiveCount: "1" } });
  f.inbox.push({ Body: JSON.stringify({ requestId: ours, response: { content: "late" } }), ReceiptHandle: "rh-late", Attributes: { ApproximateReceiveCount: "1" } });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(f.released.includes("rh-other"));
  assert.ok(f.deleted.includes("rh-late"));
  assert.ok(!f.released.includes("rh-late"));
  await d.shutdown();
});

test("connect caches the bridge's tools; an unreachable bridge leaves no tools and does not throw", async () => {
  const tools = [{ name: "k8s_list_pods", description: "list", inputSchema: {} }];
  const up = fakeSqs((req) => (req.op === "list_tools" ? { requestId: req.requestId, response: { tools } } : null));
  const d1 = new SqsMcpDispatcher("r.fifo", up.sqs, 1);
  const c1 = new SqsMCPClient("lab2", "q.fifo", d1, { listTimeoutMs: 2000, refreshMs: 60_000 });
  await c1.connect();
  assert.deepEqual(c1.getTools(), tools);
  await c1.disconnect();
  await d1.shutdown();

  const down = fakeSqs(() => null);
  const d2 = new SqsMcpDispatcher("r.fifo", down.sqs, 1);
  const c2 = new SqsMCPClient("prd", "q.fifo", d2, { listTimeoutMs: 30, refreshMs: 60_000 });
  await c2.connect();
  assert.deepEqual(c2.getTools(), []);
  await c2.disconnect();
  await d2.shutdown();
});

test("an explicit deadline is sent as given (the probe's --expired)", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, error: "expired" }));
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  await assert.rejects(d.request("q.fifo", { op: "list_tools" }, 2000, "lab2", { deadline: 123 }), /expired/);
  assert.equal(f.sent[0].body.deadline, 123);
  await d.shutdown();
});

test("parseSqsClusters: name=queue pairs; unset is none; malformed fails boot", () => {
  assert.deepEqual(parseSqsClusters(undefined), []);
  assert.deepEqual(parseSqsClusters(" "), []);
  assert.deepEqual(parseSqsClusters("lab2=devops-mcp-lab2-request.fifo, prd=devops-mcp-prd-request.fifo"), [
    { name: "lab2", requestQueueName: "devops-mcp-lab2-request.fifo" },
    { name: "prd", requestQueueName: "devops-mcp-prd-request.fifo" },
  ]);
  assert.throws(() => parseSqsClusters("lab2"), /MCP_SQS_CLUSTERS/);
  assert.throws(() => parseSqsClusters("lab2=q-not-fifo"), /\.fifo/);
  assert.throws(() => parseSqsClusters("Lab_2=q.fifo"), /name/);
  assert.throws(() => parseSqsClusters("a=q1.fifo,a=q2.fifo"), /duplicate/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd devops-ai-agent && npx tsx --test src/agent/mcp/sqs-client.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./sqs-client.js`.

- [ ] **Step 3: Implement**

`src/config/index.ts`:
1. Add this exported function above `export const config`:

```ts
/**
 * MCP_SQS_CLUSTERS="lab2=devops-mcp-lab2-request.fifo,prd=devops-mcp-prd-request.fifo" — the
 * clusters reached through an SQS bridge (multi-cluster part 1). Unset = none = today's agent.
 * Malformed fails boot: a cluster silently missing from the registry is a cluster whose alerts
 * would be investigated against the wrong one later.
 */
export function parseSqsClusters(raw: string | undefined): Array<{ name: string; requestQueueName: string }> {
  const out: Array<{ name: string; requestQueueName: string }> = [];
  for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`MCP_SQS_CLUSTERS entry "${part}" is not name=queue`);
    const name = part.slice(0, eq).trim();
    const requestQueueName = part.slice(eq + 1).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`MCP_SQS_CLUSTERS: bad cluster name "${name}" (lowercase letters, digits, -)`);
    if (!requestQueueName.endsWith(".fifo")) throw new Error(`MCP_SQS_CLUSTERS: queue for "${name}" must be a .fifo queue`);
    if (out.some((c) => c.name === name)) throw new Error(`MCP_SQS_CLUSTERS: duplicate cluster "${name}"`);
    out.push({ name, requestQueueName });
  }
  return out;
}
```

2. Inside `mcp: { … }`, after `toolTimeoutMs`, add:

```ts
    // SQS bridges to clusters that accept no inbound traffic (spec 2026-10-15-multi-cluster-sqs-bridge-design).
    sqs: {
      clusters: parseSqsClusters(process.env.MCP_SQS_CLUSTERS),
      // dedicated to MCP — never the LLM response queue (tens of tool calls per investigation
      // would keep the LLM dispatcher releasing messages that aren't its own)
      responseQueueName: process.env.MCP_SQS_RESPONSE_QUEUE ?? "devops-mcp-response.fifo",
    },
```

`src/agent/mcp/sqs-client.ts`:

```ts
// The agent's half of the SQS bridge contract (spec 2026-10-15-multi-cluster-sqs-bridge-design §3).
// One SqsMcpDispatcher per process owns the dedicated MCP response queue; one SqsMCPClient per
// cluster wraps it with MCPClient's surface. Mirrors SqsGitOpsClient's dispatcher (send → route
// by requestId → release what isn't ours → tombstone what timed out) rather than sharing a base.
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueUrlCommand,
  CreateQueueCommand,
  QueueDoesNotExist,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "crypto";
import { config } from "../../config/index.js";
import logger, { errDetail } from "../../utils/logger/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { currentTrace } from "../../utils/trace/index.js";
import { releaseVisibilitySeconds, parseResponseBody } from "../llm/sqs.js";
import type { ToolDefinition } from "../llm/types.js";

export type BridgePayload = { tools: ToolDefinition[] } | { content: string; isError?: boolean };
type SqsLike = { send(cmd: unknown, opts?: unknown): Promise<any>; destroy(): void };
interface Waiter {
  label: string;
  resolve: (p: BridgePayload) => void;
  reject: (e: Error) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SqsMcpDispatcher {
  private readonly sqs: SqsLike;
  private responseQueueUrl?: string;
  private readonly requestUrls = new Map<string, Promise<string>>();
  private readonly pending = new Map<string, Waiter>();
  private readonly issued = new Map<string, number>();
  private readonly abort = new AbortController();
  private startPromise?: Promise<void>;
  private longestTimeoutMs = 60_000;

  constructor(
    private readonly responseQueueName: string,
    sqs?: SqsLike,
    private readonly pollWaitSeconds: number = config.llm.sqs.pollWaitSeconds
  ) {
    this.sqs =
      sqs ??
      new SQSClient({
        region: config.llm.sqs.region,
        requestHandler: { connectionTimeout: 5000, requestTimeout: (pollWaitSeconds + 15) * 1000 },
        maxAttempts: 3,
      });
  }

  async request(
    requestQueueName: string,
    msg: { op: "list_tools" | "call_tool"; tool?: string; args?: Record<string, unknown> },
    timeoutMs: number,
    label: string,
    opts: { deadline?: number } = {}
  ): Promise<BridgePayload> {
    await this.ensureStarted();
    const requestUrl = await this.requestUrl(requestQueueName);
    const requestId = randomUUID();
    const deadline = opts.deadline ?? Date.now() + timeoutMs;
    this.longestTimeoutMs = Math.max(this.longestTimeoutMs, timeoutMs);

    const answer = new Promise<BridgePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.tombstone(requestId);
        reject(new Error(`bridge ${label} did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(requestId, {
        label,
        resolve: (p) => { clearTimeout(timer); resolve(p); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: requestUrl,
          MessageBody: JSON.stringify({ requestId, ...msg, deadline, traceId: currentTrace() }),
          MessageGroupId: requestId,
          MessageDeduplicationId: requestId,
        })
      );
    } catch (err) {
      this.pending.get(requestId)?.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending.delete(requestId);
    }
    logger.debug(`[mcp-sqs] → ${label} ${msg.op}${msg.tool ? ` ${msg.tool}` : ""} requestId=${requestId}`);
    return answer;
  }

  private requestUrl(name: string): Promise<string> {
    let url = this.requestUrls.get(name);
    if (!url) {
      url = this.resolveQueueUrl(name);
      this.requestUrls.set(name, url);
      url.catch(() => this.requestUrls.delete(name)); // a failed lookup is retried next call
    }
    return url;
  }

  private async resolveQueueUrl(name: string): Promise<string> {
    try {
      return (await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    } catch (err) {
      if (!(err instanceof QueueDoesNotExist)) throw err;
      logger.warn(`[mcp-sqs] queue "${name}" not found — creating`);
      return (
        await this.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }))
      ).QueueUrl!;
    }
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.responseQueueUrl = await this.resolveQueueUrl(this.responseQueueName);
    logger.info(`[mcp-sqs] response queue: ${this.responseQueueUrl}`);
    void this.dispatchLoop();
  }

  private async dispatchLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.responseQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.pollWaitSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: this.abort.signal }
        );
        this.purgeExpiredTombstones();
        for (const msg of result.Messages ?? []) {
          await this.routeMessage(msg).catch((err) => logger.error(`[mcp-sqs] routing failed (left for redelivery): ${errDetail(err)}`));
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        logger.error(`[mcp-sqs] dispatcher error — retrying in 2s: ${errDetail(err)}`);
        await sleep(2000);
      }
    }
  }

  private async routeMessage(msg: { Body?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }): Promise<void> {
    const body = parseResponseBody(msg.Body) as { requestId: string; response?: BridgePayload; error?: string } | null;
    if (!body) {
      logger.error(`[mcp-sqs] unroutable response body — deleting: ${truncate(msg.Body ?? "(empty)", 200)}`);
      await this.deleteMessage(msg.ReceiptHandle!);
      return;
    }
    const waiter = this.pending.get(body.requestId);
    if (waiter) {
      await this.deleteMessage(msg.ReceiptHandle!);
      this.pending.delete(body.requestId);
      this.tombstone(body.requestId);
      if (body.error) waiter.reject(new Error(`bridge ${waiter.label}: ${body.error}`));
      else if (!body.response) waiter.reject(new Error(`bridge ${waiter.label} returned an empty envelope`));
      else waiter.resolve(body.response);
      return;
    }
    if (this.issued.has(body.requestId)) {
      await this.deleteMessage(msg.ReceiptHandle!); // our own late reply — drop
      return;
    }
    // another replica's — release it
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.responseQueueUrl,
        ReceiptHandle: msg.ReceiptHandle!,
        VisibilityTimeout: releaseVisibilitySeconds(Number(msg.Attributes?.ApproximateReceiveCount ?? "1")),
      })
    );
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.responseQueueUrl, ReceiptHandle: receiptHandle }));
  }

  private tombstone(requestId: string): void {
    this.issued.set(requestId, Date.now() + 2 * this.longestTimeoutMs);
  }

  private purgeExpiredTombstones(): void {
    const now = Date.now();
    for (const [id, expiry] of this.issued) if (now >= expiry) this.issued.delete(id);
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const w of this.pending.values()) w.reject(new Error("MCP SQS dispatcher shutting down"));
    this.pending.clear();
    this.issued.clear();
    this.sqs.destroy();
  }
}

export class SqsMCPClient {
  private tools: ToolDefinition[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private readonly listTimeoutMs: number;
  private readonly refreshMs: number;
  private readonly callTimeoutMs: number;

  constructor(
    readonly cluster: string,
    private readonly requestQueueName: string,
    private readonly dispatcher: SqsMcpDispatcher,
    opts: { listTimeoutMs?: number; refreshMs?: number; callTimeoutMs?: number } = {}
  ) {
    this.listTimeoutMs = opts.listTimeoutMs ?? 15_000;
    this.refreshMs = opts.refreshMs ?? 300_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? config.mcp.toolTimeoutMs;
  }

  /** Never throws: one unreachable cluster must not stop the agent booting for the others. */
  async connect(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshMs);
    this.refreshTimer.unref();
  }

  private async refresh(): Promise<void> {
    try {
      const p = await this.dispatcher.request(this.requestQueueName, { op: "list_tools" }, this.listTimeoutMs, this.cluster);
      if (!("tools" in p)) throw new Error("list_tools answered without tools");
      this.tools = p.tools;
      logger.info(`[mcp-sqs] ${this.cluster}: ${p.tools.length} tools`);
    } catch (err) {
      logger.warn(`[mcp-sqs] ${this.cluster} unreachable — keeping ${this.tools.length} known tool(s): ${errDetail(err)}`);
    }
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /**
   * NEVER retries. MCPClient retries once after a reconnect, which is safe for an in-process HTTP
   * session; over SQS a retry is a second request under a new requestId, so a write whose reply was
   * lost would run twice. The model may call again — that is a decision the trace records.
   */
  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    const p = await this.dispatcher.request(this.requestQueueName, { op: "call_tool", tool: name, args: input }, this.callTimeoutMs, this.cluster);
    if (!("content" in p)) throw new Error(`bridge ${this.cluster} answered call_tool without content`);
    return p.content;
  }

  async disconnect(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
```

- [ ] **Step 4: Run the tests, the full suite and tsc**

Run: `cd devops-ai-agent && npx tsx --test src/agent/mcp/sqs-client.test.ts && npm test > /tmp/claude-1000/agent-test-b4.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/claude-1000/agent-test-b4.log; npx tsc --noEmit && echo TSC_OK`
Expected: 8/8 pass, the suite `fail 0`, `TSC_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-ai-agent && git add src/agent/mcp/sqs-client.ts src/agent/mcp/sqs-client.test.ts src/config/index.ts && git commit -m "feat(mcp): SqsMCPClient — tool calls to an outbound-only cluster over SQS, never retried"
```

---

### Task 5: `mcp:probe` + contract docs (devops-ai-agent, workspace)

**Files:**
- Create: `devops-ai-agent/src/agent/mcp/probe.ts`
- Modify:
  - `devops-ai-agent/package.json` (script);
  - `devops-ai-agent/CLAUDE.md` (gotcha bullet);
  - the workspace `/home/nvlannasik/research-devops-ai-agent/CLAUDE.md` (contract bullet). That file is NOT in any git repo, so it is edited and not committed.
- Test: `devops-ai-agent/src/agent/mcp/probe.test.ts`

**Interfaces:**
- Consumes: `SqsMcpDispatcher` (Task 4), `config.mcp.sqs` (Task 4).
- Produces: `runProbe(argv: string[], deps?: { dispatcher?: SqsMcpDispatcher; out?: (s: string) => void; err?: (s: string) => void }): Promise<number>` (exit code).

- [ ] **Step 1: Write the failing test** — `src/agent/mcp/probe.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProbe } from "./probe.js";
import { config } from "../../config/index.js";

function withClusters<T>(clusters: Array<{ name: string; requestQueueName: string }>, fn: () => Promise<T>): Promise<T> {
  const prev = config.mcp.sqs.clusters;
  (config.mcp.sqs as any).clusters = clusters;
  return fn().finally(() => { (config.mcp.sqs as any).clusters = prev; });
}

function fakeDispatcher(answer: () => Promise<any>) {
  const calls: any[] = [];
  return {
    calls,
    d: {
      request: async (q: string, msg: any, t: number, l: string, o: any = {}) => { calls.push({ q, msg, t, l, o }); return answer(); },
      shutdown: async () => {},
    } as any,
  };
}

test("unknown cluster: exit 2 and the registered names", async () => {
  const errs: string[] = [];
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () => runProbe(["prd"], { err: (s) => errs.push(s), out: () => {} }));
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /lab2/);
});

test("no tool: list_tools, prints the names and count", async () => {
  const out: string[] = [];
  const f = fakeDispatcher(async () => ({ tools: [{ name: "k8s_list_pods", description: "", inputSchema: {} }] }));
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () => runProbe(["lab2"], { dispatcher: f.d, out: (s) => out.push(s), err: () => {} }));
  assert.equal(code, 0);
  assert.equal(f.calls[0].msg.op, "list_tools");
  assert.match(out.join("\n"), /1 tool/);
  assert.match(out.join("\n"), /k8s_list_pods/);
});

test("a tool with JSON args: call_tool to the cluster's queue; --expired sends a past deadline", async () => {
  const f = fakeDispatcher(async () => ({ content: "[]", isError: false }));
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () =>
    runProbe(["lab2", "k8s_list_pods", '{"namespace":"sample-apps"}', "--expired"], { dispatcher: f.d, out: () => {}, err: () => {} })
  );
  assert.equal(code, 0);
  assert.deepEqual(f.calls[0].msg, { op: "call_tool", tool: "k8s_list_pods", args: { namespace: "sample-apps" } });
  assert.equal(f.calls[0].q, "q.fifo");
  assert.ok(f.calls[0].o.deadline < Date.now());
});

test("an error from the bridge: exit 1 with the message", async () => {
  const errs: string[] = [];
  const f = fakeDispatcher(async () => { throw new Error("bridge lab2: expired"); });
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () => runProbe(["lab2"], { dispatcher: f.d, out: () => {}, err: (s) => errs.push(s) }));
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /expired/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd devops-ai-agent && npx tsx --test src/agent/mcp/probe.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./probe.js`.

- [ ] **Step 3: Implement**

`src/agent/mcp/probe.ts`:

```ts
// npm run mcp:probe -- <cluster> [tool] [json-args] [--expired]
// Checks a cluster's SQS bridge by hand before investigations are pointed at it. In a pod:
//   node dist/src/agent/mcp/probe.js <cluster> …   (MCP_SQS_CLUSTERS must name the cluster)
import { pathToFileURL } from "url";
import { config } from "../../config/index.js";
import { SqsMcpDispatcher } from "./sqs-client.js";

const LIST_TIMEOUT_MS = 15_000;

export async function runProbe(
  argv: string[],
  deps: { dispatcher?: SqsMcpDispatcher; out?: (s: string) => void; err?: (s: string) => void } = {}
): Promise<number> {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const expired = argv.includes("--expired");
  const [cluster, tool, json] = argv.filter((a) => a !== "--expired");
  if (!cluster) {
    err("usage: mcp:probe <cluster> [tool] [json-args] [--expired]");
    return 2;
  }
  const entry = config.mcp.sqs.clusters.find((c) => c.name === cluster);
  if (!entry) {
    err(`cluster "${cluster}" is not in MCP_SQS_CLUSTERS (${config.mcp.sqs.clusters.map((c) => c.name).join(", ") || "empty"})`);
    return 2;
  }
  const dispatcher = deps.dispatcher ?? new SqsMcpDispatcher(config.mcp.sqs.responseQueueName);
  // --expired: a deadline already in the past — the bridge must answer "expired" and run nothing
  const opts = expired ? { deadline: Date.now() - 60_000 } : {};
  const t0 = Date.now();
  try {
    if (!tool) {
      const p = await dispatcher.request(entry.requestQueueName, { op: "list_tools" }, LIST_TIMEOUT_MS, cluster, opts);
      const tools = "tools" in p ? p.tools : [];
      out(`${cluster}: ${tools.length} tool(s) in ${Date.now() - t0}ms`);
      for (const t of tools) out(`  ${t.name}`);
    } else {
      const args = json ? (JSON.parse(json) as Record<string, unknown>) : {};
      const p = await dispatcher.request(entry.requestQueueName, { op: "call_tool", tool, args }, config.mcp.toolTimeoutMs, cluster, opts);
      const content = "content" in p ? p.content : "";
      out(`${cluster} ${tool}: ${"isError" in p && p.isError ? "isError" : "ok"} in ${Date.now() - t0}ms, ${Buffer.byteLength(content, "utf8")} bytes`);
      out(content);
    }
    return 0;
  } catch (e) {
    err(`${cluster}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (!deps.dispatcher) await dispatcher.shutdown();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runProbe(process.argv.slice(2)).then((code) => process.exit(code));
}
```

`package.json` `scripts`: add `"mcp:probe": "node --import tsx src/agent/mcp/probe.ts",`.

`devops-ai-agent/CLAUDE.md`, add one gotcha bullet after the `toOpenAIMessages` one:

> **Tool calls to an outbound-only cluster go through an SQS bridge, and are never retried** (`agent/mcp/sqs-client.ts`, spec `docs/superpowers/specs/2026-10-15-multi-cluster-sqs-bridge-design.md`).
> - `SqsMCPClient` has `MCPClient`'s surface, but `MCPClient` retries once after a reconnect, and over SQS a retry is a second request: a write whose reply was lost would run twice.
> - Responses arrive on `devops-mcp-response.fifo`, dedicated to MCP: tens of tool calls per investigation must not churn the LLM response queue's dispatchers.
> - A cluster whose `list_tools` fails keeps its last tools and never blocks boot.
> - `MCP_SQS_CLUSTERS` unset is today's agent.
> - `npm run mcp:probe -- <cluster> [tool] [json] [--expired]` checks a bridge by hand.

Workspace `CLAUDE.md`, under "Cross-repo contracts", after the agent ↔ llm-worker GitOps bullet:

> - **agent ↔ mcp-server SQS bridge (a cluster with no inbound traffic):** a THIRD SQS contract.
>   - Request, on `devops-mcp-<cluster>-request.fifo`: `{ requestId, op: "list_tools"|"call_tool", tool?, args?, deadline, traceId? }`.
>   - Response, on the dedicated `devops-mcp-response.fifo` (not the LLM one): `{ requestId, response: {tools} | {content, isError?} | error }`.
>   - `devops-mcp-server` with `TRANSPORT=sqs` runs the same `invokeTool` as HTTP.
>   - A request past `deadline` is answered `expired` and never run.
>   - A write tool's message is deleted before it runs (at-most-once).
>   - The agent's `SqsMCPClient` never retries.
>   - The bridge does not carry the MCP protocol: MCP sessions do not survive several replicas on one queue.
>   - Changing the shape breaks both. Spec: `devops-ai-agent/docs/superpowers/specs/2026-10-15-multi-cluster-sqs-bridge-design.md`.

- [ ] **Step 4: Run the tests, the full suite, tsc and the build**

Run: `cd devops-ai-agent && npx tsx --test src/agent/mcp/probe.test.ts && npm test > /tmp/claude-1000/agent-test-b5.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/claude-1000/agent-test-b5.log; npx tsc --noEmit && npm run build 2>&1 | tail -2 && ls dist/src/agent/mcp/probe.js && echo BUILD_OK`
Expected: 4/4 pass, the suite `fail 0`, `BUILD_OK`.

- [ ] **Step 5: Commit**

```bash
cd devops-ai-agent && git add src/agent/mcp/probe.ts src/agent/mcp/probe.test.ts package.json CLAUDE.md && git commit -m "feat(mcp): mcp:probe — check a cluster's SQS bridge by hand; contract docs"
```

---

### Task 6: Deploy and prove it live (controller)

Run by the controller after the final review, not by an implementer subagent.

- [ ] **Step 1: Push and wait for both image builds**

```bash
cd devops-mcp-server && git pull --rebase origin main && git push origin main
cd ../devops-ai-agent && git pull --rebase --autostash origin main && git push origin main
```

Wait for each repo's latest GH Actions run with `gh run view <id> --json status,conclusion`.

- [ ] **Step 2: The existing pods still start (Review Focus 1)**

Run:
```bash
kubectl -n devops-tools rollout restart deploy/devops-mcp-server deploy/devops-ai-agent
kubectl -n devops-tools rollout status deploy/devops-mcp-server --timeout=300s
kubectl -n devops-tools rollout status deploy/devops-ai-agent --timeout=400s
```
Expected:
- the mcp-server log has `skipping credential setup` and `MCP Server started in HTTP mode`;
- the agent log has `Discovered <n> MCP tools`, with the same n as before;
- the agent's `GIT_SHA` is the pushed head.

- [ ] **Step 3: Can the agent's AWS role use the new queues?**

From the agent pod (it carries the IAM Anywhere credentials), run the probe before any bridge exists. That proves only the queue access:

```bash
P=$(kubectl -n devops-tools get pods -l app.kubernetes.io/name=devops-ai-agent --field-selector=status.phase=Running -o jsonpath='{.items[-1].metadata.name}')
kubectl -n devops-tools exec $P -- env MCP_SQS_CLUSTERS=lab2=devops-mcp-lab2-request.fifo node dist/src/agent/mcp/probe.js lab2
```
Expected: `lab2: bridge lab2 did not answer within 15s`. The queues now exist; nobody polls the request queue yet.
**If the output names `AccessDenied` (or `not authorized`) — STOP and ask the user** to extend the IAM role's SQS policy to `devops-mcp-*`. IAM is not in this workspace.

- [ ] **Step 4: Deploy the lab2 bridge**

A lab-only Deployment applied directly; part 3 makes it a chart value. It reuses the existing `devops-mcp-server` ServiceAccount, read-only by configuration because `MCP_ENABLE_WRITE_TOOLS` is not set, and the agent's IAM Anywhere secret refs, verbatim from the live agent Deployment. Write it to `/tmp/claude-1000/lab2-bridge.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: devops-mcp-bridge-lab2
  namespace: devops-tools
  labels: { app.kubernetes.io/name: devops-mcp-bridge-lab2, purpose: multi-cluster-part1-lab }
spec:
  replicas: 1
  selector: { matchLabels: { app.kubernetes.io/name: devops-mcp-bridge-lab2 } }
  template:
    metadata: { labels: { app.kubernetes.io/name: devops-mcp-bridge-lab2 } }
    spec:
      serviceAccountName: devops-mcp-server
      containers:
        - name: bridge
          image: docker.io/nvlannasik/devops-mcp-server:latest
          imagePullPolicy: Always
          env:
            - { name: TRANSPORT, value: sqs }
            - { name: K8S_AUTH_MODE, value: incluster }
            - { name: MCP_SQS_REQUEST_QUEUE, value: devops-mcp-lab2-request.fifo }
            - { name: MCP_SQS_RESPONSE_QUEUE, value: devops-mcp-response.fifo }
            - { name: AWS_REGION, value: ap-southeast-1 }
            - { name: AWS_AUTH_MODE, value: iam-anywhere }
            - { name: CERT_PATH, value: /certs/tls.crt }
            - { name: CERT_KEY_PATH, value: /certs/tls.key }
            - { name: AWS_TRUST_ANCHOR_ARN, valueFrom: { secretKeyRef: { name: aws-rolesanywhere-config, key: trust-anchor-arn } } }
            - { name: AWS_ROLESANYWHERE_PROFILE_ARN, valueFrom: { secretKeyRef: { name: aws-rolesanywhere-config, key: profile-arn } } }
            - { name: AWS_ROLE_ARN, valueFrom: { secretKeyRef: { name: aws-rolesanywhere-config, key: role-arn } } }
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] }, readOnlyRootFilesystem: true }
          livenessProbe:
            exec: { command: [sh, -c, "find /tmp/bridge-heartbeat -mmin -2 | grep -q ."] }
            initialDelaySeconds: 60
            periodSeconds: 30
          resources: { requests: { cpu: 20m, memory: 96Mi }, limits: { cpu: 200m, memory: 256Mi } }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
            - { name: aws-workload-cert, mountPath: /certs, readOnly: true }
      volumes:
        - { name: tmp, emptyDir: {} }
        - { name: aws-workload-cert, secret: { secretName: workload-tls } }
```

Run: `kubectl apply -f /tmp/claude-1000/lab2-bridge.yaml && kubectl -n devops-tools rollout status deploy/devops-mcp-bridge-lab2 --timeout=300s && kubectl -n devops-tools logs deploy/devops-mcp-bridge-lab2 | grep -E "SQS bridge|AWS auth|error" | head`
Expected: `AWS auth mode: iam-anywhere`, then `MCP Server started in SQS bridge mode` with `writeTools: 0`.

- [ ] **Step 5: The four live checks**

```bash
PROBE="kubectl -n devops-tools exec $P -- env MCP_SQS_CLUSTERS=lab2=devops-mcp-lab2-request.fifo node dist/src/agent/mcp/probe.js"
$PROBE lab2                                              # list_tools
$PROBE lab2 k8s_list_pods '{"namespace":"sample-apps"}'  # a real read through SQS
$PROBE lab2 --expired                                    # deadline rule
kubectl -n devops-tools scale deploy/devops-mcp-bridge-lab2 --replicas=0 && $PROBE lab2 ; kubectl -n devops-tools scale deploy/devops-mcp-bridge-lab2 --replicas=1
```
Expected:
1. `lab2: <n> tool(s)`, with no `k8s_restart_*` / `k8s_scale` / `k8s_set_image` names.
2. `lab2 k8s_list_pods: ok in <ms>`, then a JSON list naming the sample-apps pods.
3. `lab2: bridge lab2: expired`, exit 1. The bridge log has `expired request`.
4. With the bridge at 0 replicas: `bridge lab2 did not answer within 15s`.

Then a read latency figure: run `$PROBE lab2 k8s_list_pods '{"namespace":"sample-apps"}'` three times and report the `in <ms>` values.

- [ ] **Step 6: Record**

Report push ranges, the four results and the latency figures. Leave the lab2 bridge running: part 2 uses it. Its label `purpose: multi-cluster-part1-lab` marks it for removal once part 3 makes bridges chart-managed.
