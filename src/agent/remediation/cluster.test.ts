import { test } from "node:test";
import assert from "node:assert/strict";
import { Remediator } from "./remediator.js";
import { clusterRegistry, currentCluster, withCluster } from "../cluster/index.js";
import { ClusterRouter } from "../cluster/router.js";
import { DevOpsAgent } from "../index.js";
import { TraceRecorder } from "../trace/index.js";
import type { LLMClient, ToolDefinition } from "../llm/types.js";
import type { BridgeTools, McpTools } from "../mcp/types.js";

// Multi-cluster 2a: work that runs without a thread — an approval click, a due verification —
// acts on the cluster stored on its row, never on whatever the process defaults to.
const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" }] } });
const recordingMcp = (seen: string[]) => ({
  connect: async () => {}, disconnect: async () => {}, ping: async () => true, getTools: () => [],
  callTool: async (name: string) => {
    seen.push(`${currentCluster()}:${name}`);
    return name === "alertmanager_get_alerts" ? `{"groups":[]}` : `[]`;
  },
});
const remediatorWith = (host: Record<string, unknown>) =>
  Object.assign(Object.create(Remediator.prototype), { host: { clusters: registry, trace: () => ({ gate: () => {} }), ...host } }) as Remediator;

for (const [stored, expected] of [["stg", "stg"], [null, "dev"]] as const) {
  test(`a card executes on its own cluster after a restart (stored ${stored ?? "NULL"})`, async () => {
    const seen: string[] = [];
    const r = remediatorWith({
      mcp: recordingMcp(seen),
      remediations: {
        claimForExecution: async () => ({ action: "k8s_rollout_restart", params: { namespace: "default", name: "web", kind: "deployment", summary: "restart web" }, cluster: stored }),
        finish: async () => {},
        saveBackup: async () => {},
      },
    });
    const out = await r.executeRemediation(1, "U1");
    assert.deepEqual(seen, [`${expected}:k8s_rollout_restart`]);
    assert.equal(out.cluster, expected);
  });
}

test("a due check runs against its row's cluster", async () => {
  const seen: string[] = [];
  const check = {
    id: 1, remediationId: 2, channel: "C", threadTs: "T", alertname: "KubePodCrashLooping", namespace: "default",
    target: { namespace: "default", name: "web" }, before: null, attempts: 1, createdAt: new Date().toISOString(),
    status: "running", cluster: "stg",
  };
  const r = remediatorWith({
    mcp: recordingMcp(seen),
    checks: { claimDue: async () => [check], complete: async () => {}, abandon: async () => {}, expireStale: async () => [] },
    remediations: { expireStale: async () => [] },
  });
  await r.runDueRemediationChecks();
  const k8s = seen.filter((s) => s.includes(":k8s_"));
  assert.ok(k8s.length > 0, "the check read the workload");
  assert.ok(k8s.every((s) => s.startsWith("stg:")), `every Kubernetes read on stg: ${seen.join(", ")}`);
});

// Alertmanager is central and unfiltered — dev and stg can page the same alertname+namespace —
// so the re-check itself has to reject the other cluster's record (verify.ts's alertState).
test("a due check's alert re-check rejects another cluster's alert of the same name", async () => {
  const check = {
    id: 1, remediationId: 2, channel: "C", threadTs: "T", alertname: "KubePodCrashLooping", namespace: "default",
    target: { namespace: "default", name: "web" }, before: null, attempts: 1, createdAt: new Date().toISOString(),
    status: "running", cluster: "stg",
  };
  const completed: Array<{ verdict: string; detail: string }> = [];
  const r = remediatorWith({
    mcp: {
      connect: async () => {}, disconnect: async () => {}, ping: async () => true, getTools: () => [],
      callTool: async (name: string) =>
        name === "alertmanager_get_alerts"
          ? JSON.stringify({ groups: [{ groupLabels: {}, alerts: [{ name: "KubePodCrashLooping", status: "active", labels: { namespace: "default", cluster: "dev" } }] }] })
          : `[{"name":"web-1","namespace":"default","status":"Running","ready":true}]`,
    },
    checks: {
      claimDue: async () => [check],
      complete: async (_id: number, verdict: string, detail: string) => { completed.push({ verdict, detail }); },
      abandon: async () => {},
      expireStale: async () => [],
    },
    remediations: { expireStale: async () => [] },
  });
  await r.runDueRemediationChecks();
  assert.equal(completed[0]?.verdict, "recovered", `dev's alert must not count as stg's: ${JSON.stringify(completed)}`);
});

test("a proposal runs on its thread's cluster", async () => {
  const calls: string[] = [];
  const tool = (name: string, description = name): ToolDefinition => ({ name, description, input_schema: { type: "object", properties: {} } });
  const fake = (label: string, tools: ToolDefinition[]) => ({
    connect: async () => {}, disconnect: async () => {}, ping: async () => true, getTools: () => tools,
    callTool: async (name: string, input: Record<string, unknown>) => {
      calls.push(`${label}:${name}${input.dry_run ? ":dry" : ""}`);
      if (name === "k8s_list_deployments") return JSON.stringify([{ name: "web", namespace: "default", replicas: 1, readyReplicas: 0, containers: [{ name: "web", image: "nginx:1" }] }]);
      if (name === "k8s_list_pods") return JSON.stringify([{ name: "web-abc12", namespace: "default", status: "Running", ready: false, restarts: 2 }]);
      if (input.dry_run) return JSON.stringify({ action: "rollout_restart", dryRun: true, result: "would restart deployment/default/web" });
      return "[]";
    },
  });
  const stgTools = [tool("k8s_rollout_restart", "[WRITE] restart"), tool("k8s_list_deployments"), tool("k8s_list_pods")];
  const mcp = new ClusterRouter(fake("dev", [tool("prometheus_query"), ...stgTools]) as McpTools, new Map([["stg", fake("stg", stgTools) as BridgeTools]]), registry);
  const proposal = `{"action":"k8s_rollout_restart","namespace":"default","workload":"web","kind":"deployment","reason":"the user asked for it"}`;
  const llm: LLMClient = { chat: async () => ({ content: [{ type: "text", text: proposal }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }) };
  const stored: Array<{ action: string; cluster: string | null | undefined }> = [];
  const remediations = {
    pendingFor: async () => null,
    propose: async (_incident: number | null, action: string, _params: unknown, cluster?: string | null) => {
      stored.push({ action, cluster });
      return 7;
    },
  };
  const agent = new DevOpsAgent({ llm, mcp, recorder: new TraceRecorder({ insert: async () => {} }, { source: "bench", sha: "t" }), remediations: remediations as never, clusters: registry });
  await agent.bindThreadCluster("T", "stg");
  const out = await agent.proposeRemediation(null, { namespace: "default", deployment: "web" }, "User request: restart web", { threadId: "T", userRequested: true });
  assert.ok(out && "id" in out, `a card was proposed: ${JSON.stringify(out)}`);
  assert.ok(calls.includes("stg:k8s_rollout_restart:dry"), `the dry-run ran on stg: ${calls.join(", ")}`);
  assert.ok(calls.every((c) => !c.startsWith("dev:k8s_")), `no Kubernetes call reached dev: ${calls.join(", ")}`);
  assert.deepEqual(stored, [{ action: "k8s_rollout_restart", cluster: "stg" }]);
});

test("a Flux-managed target off the local cluster gets no PR", async () => {
  const sent: string[] = [];
  const tool = (name: string, description = name): ToolDefinition => ({ name, description, input_schema: { type: "object", properties: {} } });
  const stgTools = [tool("k8s_scale", "[WRITE] scale"), tool("k8s_list_deployments"), tool("k8s_list_pods")];
  const preview = JSON.stringify({ gitOpsPrEligible: true, helmRelease: { name: "web", namespace: "flux-app" }, action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] });
  const fake = (tools: ToolDefinition[]) => ({
    connect: async () => {}, disconnect: async () => {}, ping: async () => true, getTools: () => tools,
    callTool: async (name: string, input: Record<string, unknown>) => {
      if (name === "k8s_list_deployments") return JSON.stringify([{ name: "web", namespace: "default", replicas: 1, readyReplicas: 1, containers: [{ name: "web", image: "nginx:1" }] }]);
      if (input.dry_run) return preview;
      return "[]";
    },
  });
  const mcp = new ClusterRouter(fake([tool("prometheus_query"), ...stgTools]) as McpTools, new Map([["stg", fake(stgTools) as BridgeTools]]), registry);
  const proposal = `{"action":"k8s_scale","namespace":"default","workload":"web","kind":"deployment","replicas":3,"reason":"the user asked for it"}`;
  const llm: LLMClient = { chat: async () => ({ content: [{ type: "text", text: proposal }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }) };
  const agent = new DevOpsAgent({ llm, mcp, recorder: new TraceRecorder({ insert: async () => {} }, { source: "bench", sha: "t" }), remediations: { pendingFor: async () => null, propose: async () => 7 } as never, clusters: registry });
  (agent as unknown as { gitops: unknown }).gitops = { request: async (m: { op: string }) => { sent.push(m.op); return { ok: true, op: m.op }; } };
  await agent.bindThreadCluster("T", "stg");
  const out = await agent.proposeRemediation(null, { namespace: "default", deployment: "web" }, "User request: scale web to 3", { threadId: "T", userRequested: true });
  assert.deepEqual(out, { refused: "GitOps changes for stg arrive with per-cluster repository mapping (multi-cluster part 3); a restart or a pod delete is still possible." });
  assert.deepEqual(sent, [], "the worker was never asked for a PR");
});

// A pending card is a lock on a target (RemediationStore.pendingFor, matched on params.target).
// Without a cluster in the key, a card proposed on dev would block the identical restart on stg.
test("a dev pending card does not block the same target on stg", async () => {
  const pendingKeys: string[] = [];
  const storedTargets: string[] = [];
  const proposal = `{"action":"k8s_rollout_restart","namespace":"default","workload":"web","kind":"deployment","reason":"the user asked for it"}`;
  const llm: LLMClient = { chat: async () => ({ content: [{ type: "text", text: proposal }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }) };
  const mcp = {
    getTools: () => [
      { name: "k8s_rollout_restart", description: "[WRITE] restart", input_schema: { type: "object", properties: {} } },
      { name: "k8s_list_deployments", description: "list", input_schema: { type: "object", properties: {} } },
    ],
    callTool: async (name: string, input: Record<string, unknown>) => {
      if (name === "k8s_list_deployments") return JSON.stringify([{ name: "web", namespace: "default", replicas: 1, readyReplicas: 1, containers: [{ name: "web", image: "nginx:1" }] }]);
      if (input.dry_run) return JSON.stringify({ action: "rollout_restart", dryRun: true, result: "would restart deployment/default/web" });
      return "[]";
    },
  };
  const remediations = {
    pendingFor: async (key: string) => { pendingKeys.push(key); return null; },
    propose: async (_incidentId: number | null, _action: string, params: Record<string, unknown>) => { storedTargets.push(params.target as string); return 1; },
  };
  const r = remediatorWith({ llm, mcp, remediations, recordUsage: () => {} });
  await withCluster("dev", () => r.proposeRemediation(null, { namespace: "default" }, "User request: restart web", { userRequested: true }));
  await withCluster("stg", () => r.proposeRemediation(null, { namespace: "default" }, "User request: restart web", { userRequested: true }));
  assert.deepEqual(pendingKeys, ["dev:k8s_rollout_restart:default/web", "stg:k8s_rollout_restart:default/web"]);
  assert.notEqual(pendingKeys[0], pendingKeys[1]);
  assert.deepEqual(storedTargets, pendingKeys, "the card's params.target is the same key pendingFor just checked");
});
