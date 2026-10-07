import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "../index.js";
import { TraceRecorder } from "./index.js";
import type { EventRow } from "./store.js";
import type { LLMClient, LLMResponse } from "../llm/types.js";

// A real DevOpsAgent driven by a scripted LLM and MCP — the same dependency injection replay will
// use. What it pins: every investigation is a run, written even when it throws.
const scripted = (responses: LLMResponse[]): LLMClient => {
  let i = 0;
  return {
    chat: async () => {
      const r = responses[i++];
      if (!r) throw new Error("script exhausted");
      return r;
    },
  };
};
const fakeMcp = () =>
  ({
    connect: async () => {},
    getTools: () => [{ name: "k8s_list_pods", description: "list pods", input_schema: { type: "object", properties: {} } }],
    callTool: async () => '[{"name":"web-1","ready":true,"restarts":0}]',
    disconnect: async () => {},
  }) as any;
const agentWith = (llm: LLMClient) => {
  const rows: EventRow[] = [];
  const recorder = new TraceRecorder({ insert: async (r) => void rows.push(...r) }, { source: "bench", sha: "test" });
  return { agent: new DevOpsAgent({ llm, mcp: fakeMcp(), recorder }), rows };
};

test("an investigation writes start, llm, tool, end under one run", async () => {
  const { agent, rows } = agentWith(
    scripted([
      { content: [{ type: "tool_use", id: "t1", name: "k8s_list_pods", input: { namespace: "sample-apps" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "All pods in sample-apps are healthy." }], stopReason: "end_turn" },
    ])
  );
  await agent.investigate("100.1", "how are the pods in sample-apps?", { mode: "conversation", maxToolRounds: 2 });
  const kinds = rows.filter((e) => e.kind !== "gate").map((e) => `${e.kind}:${e.name ?? ""}`);
  assert.deepEqual(kinds, ["start:", "llm:", "tool:k8s_list_pods", "llm:", "end:"]);
  assert.equal(rows[0]!.payload.source, "bench");
  assert.equal(new Set(rows.map((e) => e.payload.run)).size, 1, "one run");
  assert.match(String((rows.at(-1)!.payload as { answer: string }).answer), /healthy/);
});

test("a run whose LLM throws is still written", async () => {
  const { agent, rows } = agentWith(scripted([]));
  await assert.rejects(agent.investigate("100.2", "hi", { mode: "conversation", maxToolRounds: 2 }));
  assert.equal(rows[0]?.kind, "start");
  assert.ok(!rows.some((e) => e.kind === "end"), "no end event — the run ended in a throw");
});

// /cluster renders every namespace in full, so it must ask for detail: without it the tool now
// answers with the one-line-per-workload overview the agent's 8000-char cap can carry.
test("the dashboard's inventory asks k8s_cluster_inventory for full detail", async () => {
  const calls: Array<[string, unknown]> = [];
  const mcp = { ...fakeMcp(), callTool: async (name: string, input: unknown) => (calls.push([name, input]), "{}") };
  const agent = new DevOpsAgent({ llm: { chat: async () => { throw new Error("no llm"); } } as LLMClient, mcp: mcp as any });
  await agent.clusterInventory();
  assert.deepEqual(calls, [["k8s_cluster_inventory", { detail: true }]]);
});
