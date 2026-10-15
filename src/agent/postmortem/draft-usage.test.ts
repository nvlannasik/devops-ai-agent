import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "../index.js";
import { FIXTURE as F } from "./fixtures.js";
import type { LLMClient, LLMResponse } from "../llm/types.js";

// Final-fix item 8: draftPostmortem accepted no threadId, so its one LLM call's usage row was
// always recorded with threadTs: null — unattributable to the incident's Slack thread, unlike
// every other LLM call in the agent. The method takes an optional threadId now and forwards it.
const fakeMcp = () => ({ connect: async () => {}, getTools: () => [], callTool: async () => "", disconnect: async () => {} }) as any;

test("draftPostmortem forwards an optional threadId to recordUsage", async () => {
  const response: LLMResponse = { content: [{ type: "text", text: "## Summary\nok" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } };
  const llm: LLMClient = { chat: async () => response };
  const agent = new DevOpsAgent({ llm, mcp: fakeMcp() });
  const usageCalls: any[] = [];
  (agent as any).usage = { record: async (row: any) => { usageCalls.push(row); } };

  await agent.draftPostmortem(F, "T123");
  assert.equal(usageCalls.length, 1);
  assert.equal(usageCalls[0].threadTs, "T123");
});

test("draftPostmortem with no threadId still records usage, with threadTs: null (backward compatible)", async () => {
  const response: LLMResponse = { content: [{ type: "text", text: "## Summary\nok" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } };
  const llm: LLMClient = { chat: async () => response };
  const agent = new DevOpsAgent({ llm, mcp: fakeMcp() });
  const usageCalls: any[] = [];
  (agent as any).usage = { record: async (row: any) => { usageCalls.push(row); } };

  await agent.draftPostmortem(F);
  assert.equal(usageCalls.length, 1);
  assert.equal(usageCalls[0].threadTs, null);
});

// The writing rules live in prompts/skills/postmortem-format.md (editable, shown on /context) and
// ride in the USER message like every other skill — never in the system prompt, which stays the
// constant heading contract so it caches.
test("draftPostmortem carries the postmortem-format skill in the user message, not the system prompt", async () => {
  const seen: { messages: any[]; system?: string }[] = [];
  const llm: LLMClient = {
    chat: async (messages: any, _tools: any, system?: string) => {
      seen.push({ messages, system });
      return { content: [{ type: "text", text: "## Summary\nok" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
    },
  };
  const agent = new DevOpsAgent({ llm, mcp: fakeMcp() });
  (agent as any).usage = { record: async () => {} };
  await agent.draftPostmortem(F);
  const user = String(seen[0].messages[0].content);
  assert.match(user, /`Related alerts: 0` means no other alert joined this incident/);
  assert.ok(user.indexOf("Related alerts: 0` means") < user.indexOf("Incident #"), "the guide comes before the facts");
  assert.doesNotMatch(seen[0].system ?? "", /Related alerts: 0/);
});
