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
