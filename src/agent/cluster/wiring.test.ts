import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "../index.js";
import { TraceRecorder } from "../trace/index.js";
import type { LLMClient, LLMResponse, Message, ToolDefinition } from "../llm/types.js";
import type { BridgeTools, McpTools } from "../mcp/types.js";
import { clusterRegistry, withCluster } from "./index.js";
import { ClusterRouter } from "./router.js";
import { resetServiceGraphCache } from "../correlation/topology.js";
import { type GitOpsClient } from "../gitops/types.js";

// A real DevOpsAgent and a real ClusterRouter over recording fakes: what multi-cluster 2a promises
// end to end — a mention binds the thread, follow-ups keep it, an unbound thread gets no Kubernetes.
const tool = (name: string): ToolDefinition => ({ name, description: name, input_schema: { type: "object", properties: {} } });
// `queries` records the full call (label:name + input), beside `calls`'s plain `label:name` —
// most tests only need the latter, task 2's serviceGraphFor test needs the query text too.
const fakeMcp = (label: string, names: string[], calls: string[], queries: Array<{ label: string; name: string; input: Record<string, unknown> }> = []) => ({
  connect: async () => {},
  disconnect: async () => {},
  ping: async () => true,
  getTools: () => names.map(tool),
  callTool: async (name: string, input: Record<string, unknown> = {}) => {
    calls.push(`${label}:${name}`);
    queries.push({ label, name, input });
    // Task 5's cluster-model tests need a buildClusterModel() that actually succeeds (so caching
    // kicks in) — an empty-but-well-shaped inventory, distinct from the pods fixture every other
    // test relies on for k8s_list_pods etc.
    if (name === "k8s_cluster_inventory") return JSON.stringify({ namespaces: [], scanned: { namespaces: 0, complete: true } });
    return `[{"name":"web-1","namespace":"default","ready":true}]`;
  },
});
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
const callPods = (id: string): LLMResponse => ({ content: [{ type: "tool_use", id, name: "k8s_list_pods", input: { namespace: "default" } }], stopReason: "tool_use", usage });
const answer: LLMResponse = { content: [{ type: "text", text: "All pods look fine." }], stopReason: "end_turn", usage };

function setup(script: LLMResponse[]) {
  const calls: string[] = [];
  const queries: Array<{ label: string; name: string; input: Record<string, unknown> }> = [];
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
  const central = fakeMcp("dev", ["k8s_list_pods", "k8s_change_timeline", "k8s_cluster_inventory", "prometheus_query"], calls, queries) as McpTools;
  const stg = fakeMcp("stg", ["k8s_list_pods", "k8s_change_timeline", "k8s_cluster_inventory"], calls, queries) as BridgeTools;
  const mcp = new ClusterRouter(central, new Map([["stg", stg]]), registry);
  const recorder = new TraceRecorder({ insert: async () => {} }, { source: "bench", sha: "test" });
  return { agent: new DevOpsAgent({ llm, mcp, recorder, clusters: registry }), calls, seen, queries };
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

// Part 3 task 3: git history's overlay is resolved under the ALERT's cluster — resolveOverlayPath
// reads the HelmRelease CR via k8s_get_custom_resources, a k8s_ tool the ClusterRouter must route
// to stg, not dev; the bug fixed here ran that read outside collectChanges's read() wrapper, which
// throws "no cluster is bound" in strict mode instead of resolving anything.
function fluxFake(overlayPath: string | null) {
  return {
    connect: async () => {},
    disconnect: async () => {},
    ping: async () => true,
    getTools: () => [tool("k8s_change_timeline"), tool("k8s_get_custom_resources")],
    callTool: async (name: string, input: Record<string, unknown> = {}) => {
      if (name === "k8s_change_timeline") return JSON.stringify({ changes: [], helmReleases: [{ name: "web", namespace: "default" }] });
      if (name === "k8s_get_custom_resources" && overlayPath !== null) {
        if (input.plural === "helmreleases") {
          return JSON.stringify({ metadata: { labels: { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" } } });
        }
        if (input.plural === "kustomizations") return JSON.stringify({ spec: { path: overlayPath } });
      }
      return "[]"; // overlayPath === null: no kustomize.toolkit.fluxcd.io labels on the HelmRelease
    },
  };
}
const noLocal = { connect: async () => {}, disconnect: async () => {}, ping: async () => true, getTools: () => [], callTool: async () => "[]" };

test("history resolves the overlay under the alert's cluster", async () => {
  const calls: string[] = [];
  const stg = fluxFake("./apps/stg/applications");
  const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" }] } });
  // Final review finding 6: `noLocal` recorded nothing, so `calls` only ever held stg entries and
  // `calls.every(c => c.startsWith("stg:"))` below passed vacuously — it couldn't have caught a
  // misrouted read landing on dev. Record dev's calls too, so the assertion has something to fail on.
  const local = { ...noLocal, callTool: async (name: string, input: Record<string, unknown> = {}) => { calls.push(`dev:${name}`); return noLocal.callTool(name, input); } };
  const mcp = new ClusterRouter(local as unknown as McpTools, new Map([["stg", { ...stg, callTool: async (name: string, input: Record<string, unknown> = {}) => { calls.push(`stg:${name}`); return stg.callTool(name, input); } } as unknown as BridgeTools]]), registry);
  const sent: Array<Record<string, unknown>> = [];
  const gitops = { request: async (body: Record<string, unknown>) => { sent.push(body); return { ok: true as const, op: "history" as const, commits: [] }; } };
  const agent = new DevOpsAgent({ mcp, clusters: registry, gitops: gitops as unknown as GitOpsClient });
  const t = await agent.collectChanges({ namespace: "default", cluster: "stg" }, new Date(), []);
  assert.ok(calls.includes("stg:k8s_get_custom_resources"), `overlay lookup must reach stg: ${calls.join(", ")}`);
  assert.ok(calls.every((c) => c.startsWith("stg:")), `the Kustomization read went to stg, never dev: ${calls.join(", ")}`);
  assert.equal(sent.length, 1, "one history request");
  assert.equal(sent[0]!.pathPrefix, "apps/stg/applications");
  assert.ok(!t!.unread.some((u) => /no cluster is bound|cannot tell/.test(u)), t!.unread.join("; "));
});

test("off-local unresolved prefix gives no git source", async () => {
  const calls: string[] = [];
  const stg = fluxFake(null);
  const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" }] } });
  const mcp = new ClusterRouter(noLocal as unknown as McpTools, new Map([["stg", { ...stg, callTool: async (name: string, input: Record<string, unknown> = {}) => { calls.push(`stg:${name}`); return stg.callTool(name, input); } } as unknown as BridgeTools]]), registry);
  const sent: Array<Record<string, unknown>> = [];
  const gitops = { request: async (body: Record<string, unknown>) => { sent.push(body); return { ok: true as const, op: "history" as const, commits: [] }; } };
  const agent = new DevOpsAgent({ mcp, clusters: registry, gitops: gitops as unknown as GitOpsClient });
  const t = await agent.collectChanges({ namespace: "default", cluster: "stg" }, new Date(), []);
  assert.deepEqual(sent, [], "no history request without a resolved overlay");
  assert.ok(t!.unread.some((u) => u.includes("stg") && u.includes("web")), t!.unread.join("; "));
});

// Final review finding 2: the cluster-model `locate` closure (modelCacheFor) had no such guard —
// an unresolved overlay on a non-local cluster went out with NO pathPrefix, which the worker reads
// as "use the local repo's default prefix": the whole-repo fallback this mode forbids. Mirrors the
// history op's own guard (collectChanges), now applied to locate too.
test("stg model build with an unresolved overlay sends no locate request without pathPrefix", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const inv = JSON.stringify({
    scanned: { namespaces: 1, complete: true }, fluxRevisions: [],
    namespaces: [{ name: "flux-app", system: false, services: [], ingresses: [], workloads: [
      { kind: "Deployment", name: "web", ready: 1, desired: 1, images: ["nginx:1"], managedBy: { type: "helmrelease", name: "web", namespace: "flux-app" }, dependsOn: [], externalHosts: [], unresolved: [] },
    ] }],
  });
  const stg = {
    connect: async () => {}, disconnect: async () => {}, ping: async () => true,
    getTools: () => [tool("k8s_cluster_inventory"), tool("k8s_get_custom_resources")],
    callTool: async (name: string) => (name === "k8s_cluster_inventory" ? inv : "[]"), // "[]": no kustomize labels, overlay never resolves
  };
  const central = {
    connect: async () => {}, disconnect: async () => {}, ping: async () => true,
    getTools: () => [tool("prometheus_query")],
    callTool: async () => "not json", // callGraph: fails open to null, doesn't block the model
  };
  const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" }] } });
  const mcp = new ClusterRouter(central as unknown as McpTools, new Map([["stg", stg as unknown as BridgeTools]]), registry);
  const gitops = { request: async (m: Record<string, unknown>) => { sent.push(m); return { ok: true as const, op: "locate" as const, revision: "x", releases: [] }; } };
  const agent = new DevOpsAgent({ mcp, clusters: registry, gitops: gitops as unknown as GitOpsClient });
  const model = await withCluster("stg", () => agent.clusterModel());
  assert.deepEqual(sent, [], "no locate request without a resolved overlay");
  assert.ok(model, "the model still builds — the gap is unknowns, not a crash");
  assert.ok(model!.unknowns.some((u) => u.includes("cannot tell") && u.includes("stg")), model!.unknowns.join("; "));
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

// Part 3 task 5: the model cache used to be keyed by namespace only, so dev's and stg's models
// collapsed into the SAME entry — a tour in an stg thread could read dev's model, or vice versa.
// Now there is one cache per cluster, each built under its own withCluster.
test("each cluster has its own model", async () => {
  const { agent, calls } = setup([]);
  await withCluster("stg", () => agent.clusterModel());
  assert.ok(calls.includes("stg:k8s_cluster_inventory"), calls.join(", "));
  await withCluster("dev", () => agent.clusterModel());
  assert.ok(calls.includes("dev:k8s_cluster_inventory"), calls.join(", "));
  const before = calls.length;
  await withCluster("stg", () => agent.clusterModel());
  assert.equal(calls.length, before, "a second stg call within the TTL made no new call");
});

test("the dashboard reads the cluster it is asked for", async () => {
  const { agent, calls } = setup([]);
  await agent.clusterInventory();
  assert.deepEqual(calls, ["dev:k8s_cluster_inventory"]);
  await agent.clusterInventory("stg");
  assert.deepEqual(calls, ["dev:k8s_cluster_inventory", "stg:k8s_cluster_inventory"]);
});

test("mcpTools in strict mode lists the local cluster's tools", async () => {
  const { agent } = setup([]);
  assert.ok(agent.mcpTools().some((t) => t.name === "k8s_list_pods"), "outside any withCluster, mcpTools() still sees the local cluster's tools");
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

// Multi-cluster part 3 task 2: the correlation service-graph query (app/alerts.ts) runs under
// the ALERT's own cluster, never whatever is ambient — there is no investigation's withCluster
// at that point for it to inherit. prometheus_query is central (ClusterRouter), so the proof is
// the query text ClusterRouter.scoped() adds, reaching the central ("dev") fake.
test("serviceGraphFor runs the service-graph query under the alert's own cluster", async () => {
  resetServiceGraphCache();
  const { agent, queries } = setup([]);
  await agent.serviceGraphFor({ cluster: "stg" });
  const graphQueries = queries.filter((q) => q.name === "prometheus_query");
  assert.equal(graphQueries.length, 1);
  assert.equal(graphQueries[0]!.label, "dev", "prometheus is central, reached through the local cluster's client");
  assert.match(String(graphQueries[0]!.input.query), /cluster="stg"/);
});

// Final review finding 3: an unlabelled alert (alertCluster → null) must get NO graph at all.
// withCluster(null, run) left the query unscoped (ClusterRouter.scoped treats a falsy current
// cluster as "as written"), so this used to run the COMBINED cross-cluster query and cache it
// under the same "" key single-cluster mode uses — the doc comment said "none", the code sent one.
test("serviceGraphFor returns no graph for an unlabelled alert, and sends no query at all", async () => {
  resetServiceGraphCache();
  const { agent, queries } = setup([]);
  const graph = await agent.serviceGraphFor({});
  assert.equal(graph, null);
  assert.equal(queries.filter((q) => q.name === "prometheus_query").length, 0, "no query at all — not the unscoped cross-cluster one");
});

test("recallRemediations passes no scope in single-cluster mode", async () => {
  const registry = clusterRegistry({ localCluster: null, sqs: { clusters: [] } });
  const agent = new DevOpsAgent({ mcp: { connect: async () => {}, disconnect: async () => {}, ping: async () => true, getTools: () => [], callTool: async () => "" }, clusters: registry });
  const seen: unknown[] = [];
  (agent as any).remediations = { recallForAlert: async (...a: unknown[]) => { seen.push(a); return []; } };
  await agent.recallRemediations({ alertname: "KubePodCrashLooping", namespace: "kube-system" });
  assert.deepEqual(seen, [["KubePodCrashLooping", "kube-system", 3]]);
});

test("an alert about a registered VM is a VM incident: VM note, no Kubernetes, not capped", async () => {
  const high: LLMResponse = { content: [{ type: "text", text: "*📍 Root Cause*\nA.\n\n*📊 Evidence*\nB.\n\n*📈 Confidence:* `High` — sure." }], stopReason: "end_turn", usage };
  const { agent, calls, seen } = setup([high, high, high]);
  const out = await agent.investigate("V", "OrdersApiDown on vm-web-01", { mode: "alert", cluster: null, vm: { host: "vm-web-01", units: ["orders.service"] } });
  assert.ok(!seen[0]!.tools.some((t) => t.name.startsWith("k8s_")));
  assert.match(JSON.stringify(seen[0]!.messages), /\[Target: VM `vm-web-01`\]/);
  assert.match(JSON.stringify(seen[0]!.messages), /restarting one of its units: `orders\.service`/);
  assert.doesNotMatch(JSON.stringify(seen[0]!.messages), /\[Cluster: unknown\]/);
  assert.match(out, /Confidence:\* `High`/);
  assert.deepEqual(calls, []);
});
