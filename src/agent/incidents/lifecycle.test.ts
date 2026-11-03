import test from "node:test";
import assert from "node:assert/strict";
import { IncidentLifecycle, type LifecycleHost } from "./lifecycle.js";
import { DevOpsAgent } from "../index.js";
import { clusterRegistry } from "../cluster/index.js";

const mcp = { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true };

// Same guard as remediator.test.ts (8c60b0a): a real agent, every target stubbed, so a delegator
// that calls itself overflows here instead of in production.
test("every DevOpsAgent delegator reaches the IncidentLifecycle, not itself", async () => {
  const agent = new DevOpsAgent({ mcp });
  const l = (agent as any).lifecycle;
  assert.ok(l instanceof IncidentLifecycle);
  const reached: string[] = [];
  for (const name of Object.getOwnPropertyNames(IncidentLifecycle.prototype)) {
    if (name === "constructor") continue;
    l[name] = async () => { reached.push(name); return null; };
    await (agent as any)[name]();
  }
  assert.deepEqual(reached.sort(), ["learnFromThread", "runIncidentReconcile", "setIncidentStatus"]);
});

// Multi-cluster part 3 task 2: dev and stg can share an alertname+namespace, so the sweeper's
// one (central, unfiltered) Alertmanager read has to be checked against each incident's OWN
// cluster — never cross-read one cluster's still-firing alert as another's recovery.
test("the sweeper filters Alertmanager's combined view by each incident's own cluster", async () => {
  const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "q" }] } });
  const noted: number[] = [];
  const host: LifecycleHost = {
    incidents: {
      listUnresolved: async () => [
        { id: 1, alertname: "KubePodCrashLooping", namespace: "kube-system", channel: "C", threadTs: "1.1", groupLabels: null, clearedSeenAt: null, cluster: "dev" },
        { id: 2, alertname: "KubePodCrashLooping", namespace: "kube-system", channel: "C", threadTs: "2.2", groupLabels: null, clearedSeenAt: null, cluster: "stg" },
      ],
      noteClearedSeen: async (ids: number[]) => { noted.push(...ids); },
      resetClearedSeen: async () => {},
      markResolvedById: async () => null,
    },
    mcp: {
      callTool: async () =>
        JSON.stringify({
          groups: [{ groupLabels: {}, alerts: [{ name: "KubePodCrashLooping", status: "active", labels: { namespace: "kube-system", cluster: "dev" } }] }],
        }),
    },
    llm: {} as any,
    recordUsage: () => {},
    clusters: registry,
  } as unknown as LifecycleHost;
  const lc = new IncidentLifecycle(host);
  await lc.runIncidentReconcile();
  assert.deepEqual(noted, [2], "only stg's incident reads as cleared — dev's own alert is still firing there");
});

test("the host is read live: an incident store swapped after construction is the one used", async () => {
  const agent = new DevOpsAgent({ mcp });
  (agent as any).incidents = { findIncidentByThread: async () => null };
  assert.match(await agent.learnFromThread("C", "1.1", "U", "2.2", "t", "h"), /isn't linked/);
});
