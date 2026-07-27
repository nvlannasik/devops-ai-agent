import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAIMessages } from "./openai-compatible.js";

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
