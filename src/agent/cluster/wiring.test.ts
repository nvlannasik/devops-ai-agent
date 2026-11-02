import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "../index.js";
import { TraceRecorder } from "../trace/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition } from "../llm/types.js";
import type { BridgeTools, McpTools } from "../mcp/types.js";
import { clusterRegistry, withCluster } from "./index.js";
import { ClusterRouter } from "./router.js";

// A real DevOpsAgent and a real ClusterRouter over recording fakes: what multi-cluster 2a promises
// end to end — a mention binds the thread, follow-ups keep it, an unbound thread gets no Kubernetes.
const tool = (name: string): ToolDefinition => ({ name, description: name, input_schema: { type: "object", properties: {} } });
const fakeMcp = (label: string, names: string[], calls: string[]) => ({
  connect: async () => {},
  disconnect: async () => {},
  ping: async () => true,
  getTools: () => names.map(tool),
  callTool: async (name: string) => {
    calls.push(`${label}:${name}`);
    return `[{"name":"web-1","namespace":"default","ready":true}]`;
  },
});
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
const callPods = (id: string): LLMResponse => ({ content: [{ type: "tool_use", id, name: "k8s_list_pods", input: { namespace: "default" } }], stopReason: "tool_use", usage });
const answer: LLMResponse = { content: [{ type: "text", text: "All pods look fine." }], stopReason: "end_turn", usage };

function setup(script: LLMResponse[]) {
  const calls: string[] = [];
  const seen: Array<{ tools: ToolDefinition[]; messages: Message[] }> = [];
  let i = 0;
  const llm: LLMClient = {
    chat: async (messages, tools) => {
      seen.push({ tools, messages });
      const r = script[i++];
      if (!r) throw new Error("script exhausted");
      return r;
    },
  };
  const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" }] } });
  const central = fakeMcp("dev", ["k8s_list_pods", "k8s_change_timeline", "prometheus_query"], calls) as McpTools;
  const stg = fakeMcp("stg", ["k8s_list_pods", "k8s_change_timeline"], calls) as BridgeTools;
  const mcp = new ClusterRouter(central, new Map([["stg", stg]]), registry);
  const recorder = new TraceRecorder({ insert: async () => {} }, { source: "bench", sha: "test" });
  return { agent: new DevOpsAgent({ llm, mcp, recorder, clusters: registry }), calls, seen };
}

test("a mention binds the thread to its cluster, and a follow-up keeps it", async () => {
  const { agent, calls, seen } = setup([callPods("t1"), answer, callPods("t2"), answer]);
  const first = "di stg pod mana yang restart?";
  assert.deepEqual(await agent.applyMentionCluster("A", first), { switchedFrom: null, cluster: "stg" });
  await agent.investigate("A", first, { mode: "conversation", maxToolRounds: 2 });
  assert.deepEqual(calls, ["stg:k8s_list_pods"]);
  assert.match(JSON.stringify(seen[0]!.messages), /\[Cluster: stg\]/);

  const second = "pod yang lain bagaimana?";
  assert.deepEqual(await agent.applyMentionCluster("A", second), { switchedFrom: null, cluster: "stg" });
  await agent.investigate("A", second, { mode: "conversation", maxToolRounds: 2 });
  assert.deepEqual(calls, ["stg:k8s_list_pods", "stg:k8s_list_pods"]);
  assert.equal(await agent.threadCluster("A"), "stg");
});

test("a bound thread keeps its cluster unless the message switches", async () => {
  const { agent } = setup([]);
  await agent.applyMentionCluster("A", "cek di stg");
  assert.deepEqual(await agent.applyMentionCluster("A", "di dev juga begitu?"), { switchedFrom: null, cluster: "stg" });
  assert.deepEqual(await agent.applyMentionCluster("A", "pindah ke dev"), { switchedFrom: "stg", cluster: "dev" });
  assert.equal(await agent.threadCluster("A"), "dev");
});

test("an unbound thread offers no Kubernetes tool and is told to ask", async () => {
  const { agent, calls, seen } = setup([answer]);
  assert.deepEqual(await agent.applyMentionCluster("B", "pod mana yang restart?"), { switchedFrom: null, cluster: null });
  await agent.investigate("B", "pod mana yang restart?", { mode: "conversation", maxToolRounds: 2 });
  assert.deepEqual(seen[0]!.tools.map((t) => t.name), ["prometheus_query"]);
  assert.match(JSON.stringify(seen[0]!.messages), /\[Cluster: none\]/);
  assert.deepEqual(calls, []);
});

test("an alert with no usable cluster label runs without Kubernetes and is capped to Low", async () => {
  const high: LLMResponse = { content: [{ type: "text", text: "*📍 Root Cause*\nA.\n\n*📊 Evidence*\nB.\n\n*📈 Confidence:* `High` — sure." }], stopReason: "end_turn", usage };
  const { agent, calls, seen } = setup([high, high, high]);
  const out = await agent.investigate("C", "KubePodCrashLooping in kube-system", { mode: "alert", cluster: null });
  assert.ok(!seen[0]!.tools.some((t) => t.name.startsWith("k8s_")));
  assert.match(JSON.stringify(seen[0]!.messages), /\[Cluster: unknown\]/);
  assert.match(out, /Confidence:\* `Low` — no cluster label/);
  assert.deepEqual(calls, []);
});

test("an alert's change timeline reads its own cluster, and none when it is unlabelled", async () => {
  const { agent, calls } = setup([]);
  const at = new Date();
  const t = await agent.collectChanges({ namespace: "default", cluster: "stg" }, at, []);
  assert.deepEqual(calls, ["stg:k8s_change_timeline"]);
  assert.ok(!t!.unread.some((u) => /no cluster is bound/.test(u)), t!.unread.join("; "));
  const u = await agent.collectChanges({ namespace: "default" }, at, []);
  assert.deepEqual(calls, ["stg:k8s_change_timeline"]);
  assert.ok(u!.unread.some((x) => /no cluster is bound/.test(x)));
});

test("a mention in an unbound thread is asked for its cluster, and naming one resumes the question", async () => {
  const { agent, calls, seen } = setup([callPods("t1"), answer]);
  const ask = await agent.askForCluster("Q", "pod mana yang restart?", "pod mana yang restart?");
  assert.match(ask ?? "", /`dev`, `stg`/);
  assert.equal(seen.length, 0, "no LLM call");
  assert.deepEqual(await agent.applyMentionCluster("Q", "stg"), { switchedFrom: null, cluster: "stg" });
  assert.equal(await agent.askForCluster("Q", "stg", "stg"), null);
  await agent.investigate("Q", "stg", { mode: "conversation", maxToolRounds: 2 });
  assert.deepEqual(calls, ["stg:k8s_list_pods"]);
  assert.match(JSON.stringify(seen[0]!.messages), /pod mana yang restart/);
});

test("a bound thread asked about another cluster is told how to switch, never answered about its own", async () => {
  const { agent, calls, seen } = setup([callPods("t1"), answer]);
  await agent.applyMentionCluster("S", "cek di stg");
  const text = "unused resources on dev cluster";
  assert.deepEqual(await agent.applyMentionCluster("S", text), { switchedFrom: null, cluster: "stg" });
  assert.match((await agent.askForCluster("S", text, text)) ?? "", /`stg`[\s\S]*"switch to dev"/);
  assert.equal(seen.length, 0, "no LLM call");
  assert.equal(await agent.askForCluster("S", "pod yang lain?", "pod yang lain?"), null, "no other cluster named: no guard");
  assert.deepEqual(await agent.applyMentionCluster("S", "pindah ke dev"), { switchedFrom: "stg", cluster: "dev" });
  assert.equal(await agent.askForCluster("S", "pindah ke dev", "pindah ke dev"), null);
  await agent.investigate("S", "pindah ke dev", { mode: "conversation", maxToolRounds: 2 });
  assert.deepEqual(calls, ["dev:k8s_list_pods"]);
  assert.match(JSON.stringify(seen[0]!.messages), /unused resources on dev cluster/);
});

test("the dashboard's /cluster reads the local cluster; another cluster's thread gets no local model", async () => {
  const { agent, calls } = setup([]);
  await agent.clusterInventory();
  assert.deepEqual(calls, ["dev:k8s_cluster_inventory"]);
  assert.equal(await withCluster("stg", () => agent.clusterModel("default")), null);
  assert.deepEqual(calls, ["dev:k8s_cluster_inventory"], "no model built for stg from the local cache");
});

test("a delegate runs on its lead's cluster, not its own unbound sub-thread", async () => {
  const { agent, calls, seen } = setup([callPods("d1"), answer, answer, answer]);
  await withCluster("stg", () => agent.investigate("L/sub-1", "[DELEGATE] pods restarting?", { maxToolRounds: 2, depth: 1 }));
  assert.deepEqual(calls, ["stg:k8s_list_pods"]);
  assert.match(JSON.stringify(seen[0]!.messages), /\[Cluster: stg\]/);
});

// Identity keyed by cluster (part 3 task 1): the resolved-alert loop and remediation recall must
// scope to the alert's cluster — dev and stg share alertnames, so an unscoped query would close or
// recall the wrong cluster's row. NULL reads as the local cluster (migrations/017).
test("an unlabelled resolve closes the NULL-cluster incident (reads as local)", async () => {
  const { agent } = setup([]);
  const seen: unknown[] = [];
  (agent as any).incidents = { markResolved: async (labels: unknown, by: unknown, scope: unknown) => { seen.push([labels, by, scope]); return null; } };
  await agent.resolveIncident({ alertname: "KubePodCrashLooping", namespace: "kube-system" });
  assert.deepEqual(seen, [[{ alertname: "KubePodCrashLooping", namespace: "kube-system" }, "alertmanager", { cluster: "dev", local: "dev" }]]);
});

test("resolveIncident with cluster=stg scopes to stg", async () => {
  const { agent } = setup([]);
  const seen: unknown[] = [];
  (agent as any).incidents = { markResolved: async (labels: unknown, by: unknown, scope: unknown) => { seen.push([labels, by, scope]); return null; } };
  await agent.resolveIncident({ alertname: "KubePodCrashLooping", namespace: "kube-system", cluster: "stg" });
  assert.deepEqual(seen, [[{ alertname: "KubePodCrashLooping", namespace: "kube-system", cluster: "stg" }, "alertmanager", { cluster: "stg", local: "dev" }]]);
});

test("recallRemediations passes the alert's cluster in strict mode", async () => {
  const { agent } = setup([]);
  const seen: unknown[] = [];
  (agent as any).remediations = { recallForAlert: async (...a: unknown[]) => { seen.push(a); return []; } };
  await agent.recallRemediations({ alertname: "KubePodCrashLooping", namespace: "kube-system", cluster: "stg" });
  assert.deepEqual(seen, [["KubePodCrashLooping", "kube-system", 3, { cluster: "stg", local: "dev" }]]);
});

test("recallRemediations passes no scope in single-cluster mode", async () => {
  const registry = clusterRegistry({ localCluster: null, sqs: { clusters: [] } });
  const agent = new DevOpsAgent({ mcp: { connect: async () => {}, disconnect: async () => {}, ping: async () => true, getTools: () => [], callTool: async () => "" }, clusters: registry });
  const seen: unknown[] = [];
  (agent as any).remediations = { recallForAlert: async (...a: unknown[]) => { seen.push(a); return []; } };
  await agent.recallRemediations({ alertname: "KubePodCrashLooping", namespace: "kube-system" });
  assert.deepEqual(seen, [["KubePodCrashLooping", "kube-system", 3]]);
});
