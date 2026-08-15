import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAIMessages, wantsMaxCompletionTokens, OpenAICompatibleClient } from "./openai-compatible.js";

// a tool round-trip must never reach the model as stringified JSON — that is what made a
// small private model echo `[{"type":"tool_use",...}]` back as its answer, straight to Slack
test("content blocks become native tool_calls / tool messages", () => {
  const out = toOpenAIMessages([
    { role: "user", content: "investigate" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking pods" },
        { type: "tool_use", id: "call_1", name: "k8s_list_pods", input: { namespace: "sarang-tani" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "no pods" }] },
  ]);

  assert.deepEqual(out, [
    { role: "user", content: "investigate" },
    {
      role: "assistant",
      content: "checking pods",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "k8s_list_pods", arguments: '{"namespace":"sarang-tani"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "no pods" },
  ]);
  assert.equal(JSON.stringify(out).includes('\\"type\\"'), false); // no nested JSON anywhere
});

test("tool results are emitted before new user text in the same turn", () => {
  const out = toOpenAIMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "the label is app.kubernetes.io/name" },
        { type: "tool_result", tool_use_id: "call_1", content: "no pods" },
      ],
    },
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ["tool", "user"]
  );
});

// ---- max_tokens vs max_completion_tokens ----

const paramError = (message: string, status = 400) => Object.assign(new Error(message), { status });

test("wantsMaxCompletionTokens keys on the parameter name, not the sentence", () => {
  assert.equal(
    wantsMaxCompletionTokens(paramError("400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")),
    true
  );
  // a differently-worded future 400 that still names the parameter must still be caught
  assert.equal(wantsMaxCompletionTokens(paramError("use max_completion_tokens")), true);
});

test("other 400s are not mistaken for the parameter error", () => {
  // retrying these would just send the same doomed request twice
  assert.equal(wantsMaxCompletionTokens(paramError("400 context_length_exceeded")), false);
  assert.equal(wantsMaxCompletionTokens(paramError("max_completion_tokens", 429)), false); // rate limit, not a schema hint
  assert.equal(wantsMaxCompletionTokens(new Error("socket hang up")), false);
  assert.equal(wantsMaxCompletionTokens(undefined), false);
});

// a stub standing in for the OpenAI SDK: records each request body, rejects max_tokens once
const stubClient = (rejectsMaxTokens: boolean) => {
  const bodies: Array<Record<string, unknown>> = [];
  const create = async (body: Record<string, unknown>) => {
    bodies.push(body);
    if (rejectsMaxTokens && "max_tokens" in body) {
      throw paramError("400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
    }
    return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} };
  };
  return { bodies, api: { chat: { completions: { create } } } };
};

test("a model that rejects max_tokens is retried once with max_completion_tokens", async () => {
  const stub = stubClient(true);
  const c = new OpenAICompatibleClient({ model: "gpt-5" });
  (c as unknown as { client: unknown }).client = stub.api;

  const res = await c.chat([{ role: "user", content: "hi" }], [], "sys");
  assert.deepEqual(res.content, [{ type: "text", text: "ok" }]);
  assert.deepEqual(
    stub.bodies.map((b) => ("max_tokens" in b ? "max_tokens" : "max_completion_tokens")),
    ["max_tokens", "max_completion_tokens"]
  );

  // the lesson sticks: clients are built once at boot, so this must not cost a 400 per call
  await c.chat([{ role: "user", content: "again" }], [], "sys");
  assert.equal("max_completion_tokens" in stub.bodies[2], true);
  assert.equal(stub.bodies.length, 3);
});

test("a backend that accepts max_tokens is never switched (vLLM/DeepSeek/OpenRouter)", async () => {
  const stub = stubClient(false);
  const c = new OpenAICompatibleClient({ model: "deepseek-chat" });
  (c as unknown as { client: unknown }).client = stub.api;

  await c.chat([{ role: "user", content: "hi" }], [], "sys");
  assert.equal(stub.bodies.length, 1);
  assert.equal("max_tokens" in stub.bodies[0], true);
});

test("an unrelated failure propagates instead of being retried", async () => {
  const c = new OpenAICompatibleClient({ model: "gpt-5" });
  (c as unknown as { client: unknown }).client = {
    chat: { completions: { create: async () => { throw paramError("400 invalid tool schema"); } } },
  };
  await assert.rejects(() => c.chat([{ role: "user", content: "hi" }], [], "sys"), /invalid tool schema/);
});
