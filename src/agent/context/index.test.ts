import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRequest, injectSkills, sanitizeContentBlocks, trimToWindow } from "./index.js";
import type { Message } from "../llm/types.js";
import type { Skill } from "../skills/index.js";

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
  assert.equal((trimmed[1]!.content as any)[0].type, "tool_use");
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

const BUDGET = { contextTokens: 200_000, reserveTokens: 9_120 };
const SYSTEM = "You are a DevOps agent.\nRules follow.";
const skill = (name: string, body: string, when: Skill["when"] = /x/gi): Skill =>
  ({ name, description: "d", when, body, chars: body.length + 60 });

// THE regression test. src/agent/llm/claude.ts:26-32 wraps the entire system prompt in one
// cache_control: ephemeral block. A system prompt that varies per investigation is a full cache
// miss plus a cache WRITE at 1.25x — slower and more expensive while looking like a saving.
test("the system prompt is byte-identical no matter which skills are selected", () => {
  const history: Message[] = [{ role: "user", content: "pod is crashlooping" }];
  const a = assembleRequest({ history, systemPrompt: SYSTEM, tools: [], skills: [], budget: BUDGET });
  const b = assembleRequest({
    history, systemPrompt: SYSTEM, tools: [],
    skills: [skill("rca-format", "use this shape"), skill("oomkilled", "check the limit")],
    budget: BUDGET,
  });
  assert.equal(a.systemPrompt, SYSTEM);
  assert.equal(b.systemPrompt, SYSTEM);
  assert.equal(a.systemPrompt, b.systemPrompt);
});

test("skills ride in the first user message, and the message count is unchanged", () => {
  const history: Message[] = [
    { role: "user", content: "the alert text" },
    { role: "assistant", content: "working on it" },
  ];
  const out = assembleRequest({
    history, systemPrompt: SYSTEM, tools: [], skills: [skill("oomkilled", "check the limit")], budget: BUDGET,
  });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0]!.role, "user");
  assert.match(String(out.messages[0]!.content), /--- skill: oomkilled ---\ncheck the limit\n--- end skill: oomkilled ---/);
  assert.match(String(out.messages[0]!.content), /the alert text/);
  assert.deepEqual(out.messages[1], history[1]);
  assert.deepEqual(out.skillsUsed, ["oomkilled"]);
});

test("a block-content first message gets a text block prepended, not a stringified one", () => {
  const history: Message[] = [{ role: "user", content: [{ type: "text", text: "the alert text" }] }];
  const [m] = injectSkills(history, [skill("s", "advice")]);
  assert.ok(Array.isArray(m!.content));
  const blocks = m!.content as { type: string; text?: string }[];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type, "text");
  assert.match(blocks[0]!.text!, /--- skill: s ---/);
  assert.equal(blocks[1]!.text, "the alert text");
});

// Should not happen — a thread opens with the alert — but a skill block silently dropped is
// worse than an extra message.
test("a non-user first message gets its own skill message rather than losing the skills", () => {
  const history: Message[] = [{ role: "assistant", content: "orphan" }];
  const out = injectSkills(history, [skill("s", "advice")]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.role, "user");
  assert.match(String(out[0]!.content), /--- skill: s ---/);
});

test("no skills means the history is returned untouched", () => {
  const history: Message[] = [{ role: "user", content: "a" }];
  assert.deepEqual(injectSkills(history, []), history);
});

// The realistic squeeze is a huge PINNED tool result, not a huge skill: skills are capped at
// 8000 chars, so three of them never fill a 32k window on their own. The pins are unconditional,
// and one 66k-char log dump in the most recent message is what leaves no room for the advice.
//
// The always-skill is the exception, and used to not be: with a 66k-char pin the request is
// already past the window and the caller sends it anyway, so dropping the output format saved
// nothing and cost the one thing that makes the answer parseable downstream.
test("a small window drops matched skills but never the always-skill", () => {
  const history: Message[] = [
    { role: "user", content: "alert" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(66_000) }] },
  ];
  const skills = [skill("rca-format", "f".repeat(6_000), "always"), skill("oomkilled", "m".repeat(2_000))];
  const big = assembleRequest({ history, systemPrompt: SYSTEM, tools: [], skills, budget: BUDGET });
  const small = assembleRequest({
    history, systemPrompt: SYSTEM, tools: [], skills, budget: { contextTokens: 32_000, reserveTokens: 9_120 },
  });
  assert.deepEqual(big.skillsUsed, ["rca-format", "oomkilled"]);
  assert.deepEqual(small.skillsUsed, ["rca-format"]);
  assert.deepEqual(small.skillsDropped, ["oomkilled"]);
});

// Seen in production: skills [rollout-stuck, pod-pending] kept, rca-format DROPPED. The fill is
// greedy — a skill that does not fit is skipped and the loop continues — so the biggest skill
// went first and the small ones slid into the slack it left. rca-format IS the biggest (1834
// chars against ~550 for a playbook), so the output format lost to two optional playbooks.
test("a tight window keeps the always-skill over smaller matched ones", () => {
  const history: Message[] = [
    { role: "user", content: "alert" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(60_000) }] },
  ];
  const skills = [
    skill("rca-format", "f".repeat(1_834), "always"),
    skill("rollout-stuck", "r".repeat(558)),
    skill("pod-pending", "p".repeat(563)),
  ];
  const out = assembleRequest({
    history, systemPrompt: SYSTEM, tools: [], skills, budget: { contextTokens: 32_000, reserveTokens: 9_120 },
  });
  assert.ok(out.skillsUsed.includes("rca-format"), `output format dropped: ${out.skillsUsed.join(", ")}`);
  assert.equal(out.skillsDropped.includes("rca-format"), false);
});

test("the tool schemas are charged to the budget", () => {
  const history: Message[] = [{ role: "user", content: "alert" }];
  const bare = assembleRequest({ history, systemPrompt: SYSTEM, tools: [], skills: [], budget: BUDGET });
  const withTools = assembleRequest({
    history, systemPrompt: SYSTEM, skills: [], budget: BUDGET,
    tools: [{ name: "k8s_list_pods", description: "list pods", inputSchema: { type: "object" } }],
  });
  assert.ok(withTools.estimatedTokens > bare.estimatedTokens);
});

test("sanitizeContentBlocks compacts a tool_result and leaves other blocks alone", () => {
  const long = Array.from({ length: 400 }, () => "ERROR connection refused").join("\n");
  const out = sanitizeContentBlocks([
    { type: "text", text: "hello" },
    { type: "tool_result", tool_use_id: "1", content: long },
  ]);
  assert.deepEqual(out[0], { type: "text", text: "hello" });
  assert.ok((out[1]!.content as string).length < long.length);
  assert.match(out[1]!.content as string, /more like this/);
});

test("trimToWindow still pins the first message", () => {
  const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const out = trimToWindow(msgs, 4);
  assert.equal(out.length, 4);
  assert.equal(out[0]!.content, "m0");
  assert.equal(out[3]!.content, "m9");
});
