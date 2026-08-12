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

// The test above passes under either fill order — its skill is too large to fit in any case.
// This one separates them: the skill WOULD fit if it were offered the window first, and taking
// it would cost the middle message. 105 leaves exactly one of the two affordable after the
// 4 pinned tokens, so whichever is filled first is the one that survives.
test("a skill never takes budget a history message could have used", () => {
  const history = [user("first"), asst("m".repeat(300)), user("last")];
  const r = fitToBudget({ history, skills: [skill("advice", 300)], available: 105 });
  assert.equal(r.history.length, 3, "the middle message was traded away for a skill");
  assert.equal(r.messagesDropped, 0);
  assert.deepEqual(r.skillsDropped, ["advice"]);
});

// 160 is the window where the tie-break decides the outcome rather than merely the order:
// after `core` (50) there is room for `matched-small` (50) OR `matched-big` (100), not both.
// Sorted largest-first the big one is taken and the small one is dropped — a different result,
// which is what makes this assertion mean something.
test("an always-skill outranks a matched one, and among matched the largest drops first", () => {
  const skills = [skill("matched-big", 300), skill("matched-small", 150), skill("core", 150, "always")];
  const r = fitToBudget({ history: [user("a")], skills, available: 160 });
  assert.deepEqual(r.skills.map((s) => s.name), ["core", "matched-small"]);
  assert.deepEqual(r.skillsDropped, ["matched-big"]);
});

// The early return for an empty history used to hand back every skill unmeasured.
test("with no history at all the skills are still measured against the budget", () => {
  const r = fitToBudget({ history: [], skills: [skill("big", 3000)], available: 10 });
  assert.deepEqual(r.skills, []);
  assert.deepEqual(r.skillsDropped, ["big"]);
  assert.equal(r.messagesDropped, 0);
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
  // 4 is below the 5 tokens the pinned trio costs. Pinning is unconditional; the middle-fill is
  // not. So with the pairing removed the tool_use has only the budgeted path to arrive by, and
  // cannot afford it — the window comes back as first + orphaned tool_result. A budget large
  // enough for the middle-fill would pick the cheap tool_use up either way and assert nothing.
  const r = fitToBudget({ history, skills: [], available: 4 });
  const kinds = r.history.map((m) => (Array.isArray(m.content) ? m.content[0]!.type : "text"));
  assert.deepEqual(kinds, ["text", "tool_use", "tool_result"]);
});
