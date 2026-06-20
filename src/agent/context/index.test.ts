import { test } from "node:test";
import assert from "node:assert/strict";
import { trimToWindow, trimHistory, truncateToolResult, sanitizeContentBlocks } from "./index.js";
import type { Message } from "../llm/types.js";

const userText = (text: string): Message => ({ role: "user", content: text });
const assistantToolUse = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "k8s_list_pods", input: {} }],
});
const userToolResult = (id: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

// Every tool_result must be preceded by an assistant tool_use with the same id,
// otherwise the Anthropic API rejects the request with a 400.
function assertPairingValid(messages: Message[]): void {
  const seenToolUseIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id) {
        seenToolUseIds.add(block.id);
      }
      if (block.type === "tool_result") {
        assert.ok(
          block.tool_use_id && seenToolUseIds.has(block.tool_use_id),
          `orphaned tool_result for ${block.tool_use_id} — its tool_use was trimmed away`,
        );
      }
    }
  }
}

// issue, then N rounds of (assistant tool_use, user tool_result), then a final text.
function buildInvestigation(rounds: number): Message[] {
  const messages: Message[] = [userText("payment pods are OOMKilled")];
  for (let i = 0; i < rounds; i++) {
    messages.push(assistantToolUse(`call-${i}`), userToolResult(`call-${i}`));
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: "RCA done" }] });
  return messages;
}

test("trimToWindow returns the array untouched when under the cap", () => {
  const messages = buildInvestigation(1); // 4 messages
  assert.deepEqual(trimToWindow(messages, 40), messages);
});

test("trimToWindow keeps the original issue at index 0", () => {
  const messages = buildInvestigation(20);
  const trimmed = trimToWindow(messages, 6);
  assert.equal(trimmed[0], messages[0]);
});

test("trimToWindow never orphans a tool_result at the window boundary", () => {
  // len 8: cap 5 makes the naive slice start on a tool_result whose tool_use is gone
  const messages = buildInvestigation(3);
  const trimmed = trimToWindow(messages, 5);
  assertPairingValid(trimmed);
  // the boundary was advanced past the orphan, so it lands on the assistant turn
  assert.equal((trimmed[1].content as any)[0].type, "tool_use");
});

test("trimToWindow keeps pairing valid across many cap sizes", () => {
  const messages = buildInvestigation(15);
  for (let cap = 2; cap <= messages.length; cap++) {
    const trimmed = trimToWindow(messages, cap);
    assertPairingValid(trimmed);
    assert.ok(trimmed.length <= cap);
    assert.equal(trimmed[0], messages[0]);
  }
});

test("trimHistory enforces the 40-message window with valid pairing", () => {
  const messages = buildInvestigation(40); // 82 messages
  const trimmed = trimHistory(messages);
  assert.ok(trimmed.length <= 40);
  assertPairingValid(trimmed);
});

test("truncateToolResult appends an honest truncation notice", () => {
  const long = "x".repeat(9000);
  const out = truncateToolResult(long);
  assert.ok(out.startsWith("x".repeat(8000)));
  assert.match(out, /\.\.\.\[truncated 1000 chars\]$/);
});

test("truncateToolResult leaves short content alone", () => {
  assert.equal(truncateToolResult("short"), "short");
});

test("sanitizeContentBlocks truncates only oversized tool_result blocks", () => {
  const blocks = sanitizeContentBlocks([
    { type: "tool_result", tool_use_id: "a", content: "y".repeat(9000) },
    { type: "tool_result", tool_use_id: "b", content: "small" },
    { type: "text", text: "z".repeat(9000) },
  ]);
  assert.match(blocks[0].content as string, /truncated 1000 chars/);
  assert.equal(blocks[1].content, "small");
  assert.equal((blocks[2].text as string).length, 9000); // text blocks untouched
});
