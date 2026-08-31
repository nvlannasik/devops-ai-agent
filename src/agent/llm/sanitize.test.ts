import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForWire, stripLoneSurrogates } from "./sanitize.js";
import type { Message } from "./types.js";

// "🔴" is U+1F534 — two UTF-16 code units. Splitting it is what every fixed-offset slice over
// model-written text risks, and the RCA format is full of these.
const HIGH = "🔴".charAt(0); // lone high surrogate, what slice(0, n) leaves behind
const LOW = "🔴".charAt(1); // lone low surrogate, what slice(-n) starts with

const hasBareEscape = (json: string): boolean => /\\u[dD][89abAB][0-9a-fA-F]{2}/.test(json);

// The exact production failure: JSON.stringify emits `\ud83d` unpaired, and the server rejects
// the whole body with "no low surrogate in string" — before the model ever sees the request.
test("a lone surrogate would otherwise reach the wire as a bare \\ud escape", () => {
  assert.ok(hasBareEscape(JSON.stringify({ text: `abc${HIGH}` })), "test premise no longer holds");
  assert.ok(!hasBareEscape(JSON.stringify({ text: stripLoneSurrogates(`abc${HIGH}`) })));
});

test("both halves are caught — head slices leave a high one, tail slices a low one", () => {
  assert.equal(stripLoneSurrogates(`evidence${HIGH}`), "evidence�");
  assert.equal(stripLoneSurrogates(`${LOW}evidence`), "�evidence");
});

test("a well-formed pair is left exactly as it is", () => {
  const rca = "*🔴 Severity:* `Critical`\n*📍 Root Cause* 📈";
  assert.equal(stripLoneSurrogates(rca), rca);
});

test("text with nothing to fix comes back unchanged", () => {
  const plain = "deployments.apps \"order-service\" not found";
  assert.equal(stripLoneSurrogates(plain), plain);
});

// The regex carries the `g` flag so it can replace every occurrence; `test()` on a `g` regex
// advances lastIndex, so a shared instance would answer false on every other call.
test("repeated calls on the shared regex do not alternate", () => {
  for (let i = 0; i < 4; i++) {
    assert.equal(stripLoneSurrogates(`x${HIGH}`), "x�", `call ${i + 1} skipped the replacement`);
  }
});

// Every string in the payload, not just the top-level ones: a tool_result body is what
// compactToolResult sliced, and a tool_use input is written by the model.
test("sanitizeForWire reaches string content, block text, tool_result content and tool_use input", () => {
  const messages: Message[] = [
    { role: "user", content: `plain${HIGH}` },
    {
      role: "assistant",
      content: [
        { type: "text", text: `thinking${HIGH}` },
        { type: "tool_use", id: "t1", name: "loki_query_range", input: { query: `{app="x"}${HIGH}` } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `logs${HIGH}` }] },
  ];

  const out = sanitizeForWire(messages, `system${HIGH}`);
  assert.ok(!hasBareEscape(JSON.stringify(out)), "a lone surrogate survived somewhere in the payload");
  assert.equal(out.systemPrompt, "system�");
  assert.equal(out.messages[0].content, "plain�");

  const blocks = out.messages[1].content as { text?: string; input?: Record<string, unknown> }[];
  assert.equal(blocks[0].text, "thinking�");
  assert.equal(blocks[1].input!.query, '{app="x"}�');
  assert.equal((out.messages[2].content as { content?: string }[])[0].content, "logs�");
});

// The shape has to survive intact — the clients hand this straight to the SDKs.
test("sanitizeForWire preserves the message shape and non-string values", () => {
  const messages: Message[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "k8s_scale", input: { replicas: 3, dry_run: true, labels: null } }] },
  ];
  const out = sanitizeForWire(messages, "clean");
  assert.deepEqual(out.messages, messages);
  assert.equal(out.systemPrompt, "clean");
});
