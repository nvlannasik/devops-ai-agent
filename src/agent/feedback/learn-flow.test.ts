import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "../index.js";

// learnFromThread end to end, through stubs (the class connects nothing until initialize()).
// Incident 208: no human statement, and the extraction model returned the agent's own RCA.
const flow = async (humanText: string, extraction: string) => {
  const stored: unknown[] = [];
  let llmCalls = 0;
  const self = {
    incidents: {
      findIncidentByThread: async () => 208,
      storeFeedback: async (_id: number, f: unknown) => (stored.push(f), "stored"),
    },
    llm: { chat: async () => (llmCalls++, { content: [{ type: "text", text: extraction }], stopReason: "end_turn" }) },
    recordUsage: () => {},
    extractText: (DevOpsAgent.prototype as any).extractText,
  };
  const reply: string = await (DevOpsAgent.prototype as any).learnFromThread.call(self, "C1", "1.1", "U1", "2.2", "transcript", humanText);
  return { reply, stored, llmCalls };
};
const BOT_RCA = '{"confirmed_root_cause":"Certificate workload-cert was renewed but workload-tls was not reloaded","action_taken":null,"outcome":"unknown"}';

test("nothing a human stated: no extraction call, nothing stored", async () => {
  const r = await flow("", BOT_RCA);
  assert.equal(r.llmCalls, 0);
  assert.equal(r.stored.length, 0);
  assert.match(r.reply, /nothing a human/i);
});

test("an extraction lifted from the bot's messages is not stored as confirmed", async () => {
  const r = await flow("looks fine to me, nothing to do", BOT_RCA);
  assert.equal(r.stored.length, 0);
  assert.match(r.reply, /my own messages/i);
});

test("a cause the human actually stated is still learned", async () => {
  const r = await flow(
    "it was ORDER_RESPONSE_VERSION=2 on orders-api, set it back to 1",
    '{"confirmed_root_cause":"orders-api returned v2 bodies (ORDER_RESPONSE_VERSION=2)","action_taken":"set ORDER_RESPONSE_VERSION back to 1","outcome":"resolved"}'
  );
  assert.equal(r.stored.length, 1);
  assert.match(r.reply, /Learned/);
});
