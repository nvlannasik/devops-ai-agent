import { test } from "node:test";
import assert from "node:assert/strict";
import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { DevOpsAgent } from "../agent/index.js";
import { TraceRecorder } from "../agent/trace/index.js";
import type { EventRow } from "../agent/trace/store.js";
import type { LLMClient, LLMResponse } from "../agent/llm/types.js";
import { ALLOWED_ATTRIBUTES } from "./spans.js";

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// The same scripted-client agent as agent/trace/wiring.test.ts: a real investigation, every span
// produced by the real seams (runner, instrumentLLM, instrumentMCP, TraceRecorder.gate).
const QUESTION = "SECRET-QUESTION how are the pods in sample-apps?";
const TOOL_RESULT = '[{"name":"web-1","ready":true,"note":"SECRET-TOOL-RESULT"}]';
const scripted = (responses: Array<LLMResponse | Error>): LLMClient => {
  let i = 0;
  return {
    chat: async () => {
      const r = responses[i++];
      if (!r) throw new Error("script exhausted");
      if (r instanceof Error) throw r;
      return r;
    },
  };
};
const agentWith = (llm: LLMClient) => {
  const rows: EventRow[] = [];
  const recorder = new TraceRecorder({ insert: async (r) => void rows.push(...r) }, { source: "bench", sha: "test" });
  const mcp = {
    connect: async () => {},
    getTools: () => [{ name: "k8s_list_pods", description: "list pods", input_schema: { type: "object", properties: {} } }],
    callTool: async () => TOOL_RESULT,
    disconnect: async () => {},
  } as any;
  return { agent: new DevOpsAgent({ llm, mcp, recorder }), rows };
};
const usage = { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheCreationTokens: 0 };

test("one investigation: an investigate span with chat and execute_tool children, gates as events, metadata only", async () => {
  exporter.reset();
  const { agent, rows } = agentWith(
    // The same call twice: the second is the repeat-call gate's, so a gate fires for certain.
    scripted([
      { content: [{ type: "tool_use", id: "t1", name: "k8s_list_pods", input: { namespace: "sample-apps" } }], stopReason: "tool_use", usage, backend: "chatgpt", route: "light", model: "gpt-5-mini" },
      { content: [{ type: "tool_use", id: "t2", name: "k8s_list_pods", input: { namespace: "sample-apps" } }], stopReason: "tool_use", usage, backend: "chatgpt", route: "light", model: "gpt-5-mini" },
      { content: [{ type: "text", text: "SECRET-ANSWER all pods healthy." }], stopReason: "end_turn", usage, backend: "chatgpt", route: "light", model: "gpt-5-mini" },
    ])
  );
  await agent.investigate("100.1", QUESTION, { mode: "conversation", maxToolRounds: 3, namespace: "sample-apps" });
  const spans = exporter.getFinishedSpans();
  const inv = spans.find((s) => s.name === "investigate")!;
  assert.ok(inv, "an investigate span");
  assert.equal(inv.attributes["slack.thread_ts"], "100.1");
  assert.equal(inv.attributes["agent.run_mode"], "conversation");
  assert.equal(inv.attributes["agent.source"], "bench");
  assert.equal(inv.attributes["alert.namespace"], "sample-apps");
  const chats = spans.filter((s) => s.name === "chat gpt-5-mini");
  assert.equal(chats.length, 3);
  assert.equal(chats[0]!.attributes["gen_ai.usage.input_tokens"], 1200);
  assert.equal(chats[0]!.attributes["llm.backend"], "chatgpt");
  // The repeat was answered from the memo, so exactly one call reached the MCP client.
  const tool = spans.find((s) => s.name === "execute_tool k8s_list_pods")!;
  assert.equal(tool.attributes["tool.result.chars"], TOOL_RESULT.length);
  for (const child of [...chats, tool]) assert.equal(child.parentSpanContext?.spanId, inv.spanContext().spanId);

  // Every gate the harness recorded is an event on the investigation, by name and outcome only.
  const gateRows = rows.filter((r) => r.kind === "gate");
  assert.ok(gateRows.length > 0, "the scripted run fires at least one gate, or this check proves nothing");
  assert.equal(inv.events.filter((e) => e.name === "gate").length, gateRows.length);

  // The allowlist, and no content: the question, the tool result and the answer appear nowhere.
  for (const s of spans) {
    const all = [s.attributes, ...s.events.map((e) => e.attributes ?? {})];
    for (const attrs of all) {
      for (const [k, v] of Object.entries(attrs)) {
        assert.ok(ALLOWED_ATTRIBUTES.has(k), `attribute ${k} on ${s.name} is not on the allowlist`);
        assert.ok(String(v).length <= 200, `attribute ${k} on ${s.name} is ${String(v).length} chars`);
        assert.ok(!/SECRET-/.test(String(v)), `content leaked into ${k} on ${s.name}`);
      }
    }
  }

  // The harness run carries the OTel trace id, which is what the dashboard links to Jaeger.
  assert.equal(rows.find((r) => r.kind === "start")!.payload.otelTraceId, inv.spanContext().traceId);
});

test("an LLM call that throws: the chat span is ERROR and the same error reaches the caller", async () => {
  exporter.reset();
  const boom = new Error("backend down");
  const { agent } = agentWith(scripted([boom]));
  await assert.rejects(agent.investigate("100.2", "hi", { mode: "conversation", maxToolRounds: 2 }), (e) => e === boom);
  const chat = exporter.getFinishedSpans().find((s) => s.name.startsWith("chat"))!;
  assert.equal(chat.status.code, SpanStatusCode.ERROR);
  assert.equal(exporter.getFinishedSpans().find((s) => s.name === "investigate")!.status.code, SpanStatusCode.ERROR);
});
