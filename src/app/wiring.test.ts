import test from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";
import { ThreadCommands } from "./commands.js";

// 2026-10-21: every flow reads SlackApp through one host object. A host function that calls itself
// (8c60b0a was exactly that, in DevOpsAgent) overflows here, on a real SlackApp prototype with
// the targets stubbed, rather than on the first Slack event.
const wired = () => {
  const s = Object.assign(Object.create(SlackApp.prototype), {
    agent: { a: 1 }, app: { b: 1 }, verifyTimer: null, stopping: false,
    unstored: new Map(), tourThreads: new Set(),
  });
  (s as any).wire();
  return s as any;
};

test("the host reads SlackApp live, and verifyTimer writes through", () => {
  const s = wired();
  const other = { a: 2 };
  s.agent = other;
  assert.equal(s.host.agent, other);
  const t = setTimeout(() => {}, 0);
  clearTimeout(t);
  s.host.verifyTimer = t;
  assert.equal(s.verifyTimer, t);
});

test("each shared host method reaches SlackApp's own method", async () => {
  const s = wired();
  const reached: string[] = [];
  for (const m of ["postRca", "conversationReply", "warnIfUngrounded", "notifyIfLowConfidence", "mayUseAgent"]) {
    s[m] = async () => { reached.push(m); return ""; };
    await s.host[m]();
  }
  assert.equal(reached.length, 5);
});

test("the command host functions reach ThreadCommands, not themselves", async () => {
  const s = wired();
  assert.ok(s.commands instanceof ThreadCommands);
  const reached: string[] = [];
  for (const m of ["handleLearn", "handlePostmortem", "handleStatusCommand"]) {
    s.commands[m] = async () => void reached.push(m);
    await s.host[m]();
  }
  assert.deepEqual(reached, ["handleLearn", "handlePostmortem", "handleStatusCommand"]);
});
