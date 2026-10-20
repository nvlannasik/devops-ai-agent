import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "./index.js";

// Dashboard /memory (2026-10-20): the page shows what the agent would read, so it must call the
// agent's own recall — never a second copy of it — and read conversation memory read-only.
const mcp = { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true };

test("memoryRecall is the agent's own two recalls for the key, with no alert text", async () => {
  const agent = new DevOpsAgent({ mcp });
  const seen: unknown[] = [];
  (agent as any).incidents = { recall: async (labels: unknown, opts: unknown) => { seen.push(["incidents", labels, opts]); return "INC"; } };
  (agent as any).remediations = { recallForAlert: async (a: unknown, n: unknown) => { seen.push(["remediations", a, n]); return []; } };
  const out = await agent.memoryRecall({ alertname: "KubePodCrashLooping", namespace: "apps" });
  assert.deepEqual(out, { incidents: "INC", remediations: "" });
  assert.deepEqual(seen, [
    ["incidents", { alertname: "KubePodCrashLooping", namespace: "apps" }, { queryText: undefined }],
    ["remediations", "KubePodCrashLooping", "apps"],
  ]);
});

test("conversationThreads / conversationThread read ConversationMemory and write nothing", async () => {
  const agent = new DevOpsAgent({ mcp });
  await (agent as any).memory.append("1700000000.000100", { role: "user", content: "q" });
  const list = await agent.conversationThreads();
  assert.deepEqual(list.map((t) => [t.threadId, t.messages]), [["1700000000.000100", 1]]);
  assert.equal((await agent.conversationThread("1700000000.000100"))?.messages[0].content, "q");
  assert.equal(await agent.conversationThread("2.2"), null);
});
