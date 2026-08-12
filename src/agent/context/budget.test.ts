import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessage, fitToBudget, CHARS_PER_TOKEN } from "./budget.js";
import type { Message } from "../llm/types.js";
import type { Skill } from "../skills/index.js";

const user = (text: string): Message => ({ role: "user", content: text });
const asst = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
const skill = (name: string, size: number, when: Skill["when"] = /x/gi): Skill =>
  ({ name, description: "d", when, body: "b".repeat(size), chars: size });

test("estimation is pessimistic on purpose — 3 chars per token, never 4", () => {
  assert.equal(estimateTokens("abcdef"), 2);
  assert.equal(CHARS_PER_TOKEN, 3);
  // Under-estimating produces a 400 or a silent server-side truncation; over-estimating
  // only wastes window.
  assert.ok(estimateTokens("x".repeat(1200)) >= 1200 / 4);
});

test("estimation is monotonic in length", () => {
  assert.ok(estimateTokens("x".repeat(100)) < estimateTokens("x".repeat(200)));
});

test("a block message counts its text, its tool input and its tool result", () => {
  const m: Message = { role: "user", content: [
    { type: "text", text: "abc" },
    { type: "tool_result", tool_use_id: "1", content: "defghi" },
  ] };
  assert.equal(estimateMessage(m), estimateTokens("abc") + estimateTokens("defghi"));
});

test("everything fits — nothing is dropped", () => {
  const history = [user("a"), asst("b"), user("c")];
  const r = fitToBudget({ history, skills: [skill("s", 30)], available: 10_000 });
  assert.equal(r.history.length, 3);
  assert.equal(r.skills.length, 1);
  assert.deepEqual(r.skillsDropped, []);
  assert.equal(r.messagesDropped, 0);
});

// History is evidence already gathered; a skill is advice. Advice goes first.
test("under pressure the skills go before the history", () => {
  const history = [user("a".repeat(300)), asst("b".repeat(300)), user("c".repeat(300))];
  const r = fitToBudget({ history, skills: [skill("big", 3000)], available: 300 });
  assert.deepEqual(r.skillsDropped, ["big"]);
  assert.equal(r.history.length, 3, "no message dropped while a skill was still droppable");
});

test("an always-skill outranks a matched one, and among matched the largest drops first", () => {
  const skills = [skill("matched-big", 600), skill("matched-small", 150), skill("core", 150, "always")];
  const r = fitToBudget({ history: [user("a")], skills, available: 150 });
  assert.deepEqual(r.skills.map((s) => s.name), ["core", "matched-small"]);
  assert.deepEqual(r.skillsDropped, ["matched-big"]);
});

test("the first and the most recent message are never dropped", () => {
  const history = [user("first"), asst("mid"), user("last")];
  const r = fitToBudget({ history, skills: [], available: 1 });
  assert.deepEqual(r.history.map((m) => m.content), ["first", "last"]);
  assert.equal(r.messagesDropped, 1);
});

// The API rejects a tool_result whose tool_use is gone, with a 400 that kills exactly the long
// investigations this budget exists to keep alive.
test("a trimmed window never opens on an orphaned tool_result", () => {
  const history: Message[] = [
    user("first"),
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "k8s", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(900) }] },
    asst("summary"),
    user("last"),
  ];
  // 308 is chosen so the tool_result (300 tokens) fits and its tool_use (2) does not — the exact
  // window where the orphan actually appears. A budget too small to reach the tool_result would
  // pass this assertion without ever running the code it is about.
  const r = fitToBudget({ history, skills: [], available: 308 });
  const second = r.history[1]!;
  const orphan = Array.isArray(second.content) && second.content.some((b) => b.type === "tool_result");
  assert.equal(orphan, false, "the window starts on an orphaned tool_result");
});

// The pinned last message is usually the tool_result the assistant is waiting on. Pinning it
// without its tool_use produces the same 400 from the other end of the array.
test("a final tool_result keeps the tool_use that produced it", () => {
  const history: Message[] = [
    user("first"),
    asst("filler ".repeat(200)),
    { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "k8s", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "r" }] },
  ];
  const r = fitToBudget({ history, skills: [], available: 20 });
  const kinds = r.history.map((m) => (Array.isArray(m.content) ? m.content[0]!.type : "text"));
  assert.deepEqual(kinds, ["text", "tool_use", "tool_result"]);
});
