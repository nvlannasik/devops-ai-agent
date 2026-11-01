import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterRegistry, withCluster } from "./index.js";
import { ClusterRouter, createMcp, isClusterTool } from "./router.js";
import type { McpTools, BridgeTools } from "../mcp/types.js";

const tool = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });
const fake = (label: string, names: string[], opts: { fail?: boolean; failConnect?: boolean } = {}) => {
  const calls: string[] = [];
  const t = {
    calls,
    connected: false,
    connect: async () => {
      if (opts.failConnect) throw new Error(`${label} connect down`);
      t.connected = true;
    },
    disconnect: async () => {},
    getTools: () => names.map(tool),
    ping: async () => label === "central",
    callTool: async (name: string) => {
      calls.push(name);
      if (opts.fail) throw new Error("timed out");
      return `${label}:${name}`;
    },
  };
  return t;
};
const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" }] } });
const centralTools = ["k8s_list_pods", "flux_reconcile", "prometheus_query", "loki_query"];
const setup = (stgOpts: { fail?: boolean; failConnect?: boolean } = {}, stgNames = ["k8s_list_pods", "k8s_describe_pod"]) => {
  const central = fake("central", centralTools);
  const stg = fake("stg", stgNames, stgOpts);
  const router = new ClusterRouter(central as McpTools, new Map<string, BridgeTools>([["stg", stg]]), registry);
  return { central, stg, router };
};
const names = (r: ClusterRouter) => r.getTools().map((t) => t.name).sort();

test("cluster tools go to the thread's cluster, the rest to central", async () => {
  const { central, stg, router } = setup();
  await withCluster("stg", async () => {
    assert.equal(await router.callTool("k8s_list_pods", {}), "stg:k8s_list_pods");
    assert.equal(await router.callTool("prometheus_query", {}), "central:prometheus_query");
  });
  await withCluster("dev", async () => assert.equal(await router.callTool("k8s_list_pods", {}), "central:k8s_list_pods"));
  assert.deepEqual(stg.calls, ["k8s_list_pods"]);
  assert.deepEqual(central.calls, ["prometheus_query", "k8s_list_pods"]);
  assert.ok(isClusterTool("flux_reconcile") && isClusterTool("k8s_x") && !isClusterTool("loki_query"));
});

test("no cluster, no Kubernetes", async () => {
  const { central, stg, router } = setup();
  for (const run of [<T>(fn: () => Promise<T>) => withCluster(null, fn), <T>(fn: () => Promise<T>) => fn()]) {
    await run(async () => {
      assert.deepEqual(names(router), ["loki_query", "prometheus_query"]);
      await assert.rejects(router.callTool("k8s_list_pods", {}), (e: Error) => /no cluster/.test(e.message) && /dev, stg/.test(e.message));
    });
  }
  assert.deepEqual([...central.calls, ...stg.calls], []);
});

test("an unknown cluster is refused, never sent to central", async () => {
  const { central, router } = setup();
  await withCluster("prd", async () => {
    await assert.rejects(router.callTool("k8s_list_pods", {}), /prd/);
  });
  assert.deepEqual(central.calls, []);
});

test("a bridge's own prometheus tools do not shadow central", async () => {
  const { central, stg, router } = setup({}, ["k8s_list_pods", "prometheus_query"]);
  await withCluster("stg", async () => {
    assert.equal(router.getTools().filter((t) => t.name === "prometheus_query").length, 1);
    assert.deepEqual(names(router), ["k8s_list_pods", "loki_query", "prometheus_query"]);
    assert.equal(await router.callTool("prometheus_query", {}), "central:prometheus_query");
  });
  assert.deepEqual(stg.calls, []);
  assert.deepEqual(central.calls, ["prometheus_query"]);
});

test("an unreachable bridge says so", async () => {
  const { router } = setup({ fail: true });
  await withCluster("stg", async () => {
    await assert.rejects(router.callTool("k8s_list_pods", {}), (e: Error) => e.message.startsWith("Kubernetes for stg was unreachable through its bridge:"));
  });
});

test("a delegate keeps its lead's cluster", async () => {
  const { stg, router } = setup();
  await withCluster("stg", () => Promise.all([router.callTool("k8s_list_pods", {}), (async () => router.callTool("k8s_describe_pod", {}))()]));
  assert.deepEqual(stg.calls.sort(), ["k8s_describe_pod", "k8s_list_pods"]);
});

test("single-cluster mode returns the central client unchanged", () => {
  const central = fake("central", centralTools) as McpTools;
  const single = clusterRegistry({ localCluster: null, sqs: { clusters: [] } });
  assert.equal(createMcp(single, central, () => { throw new Error("no bridge in single-cluster mode"); }), central);
  assert.ok(createMcp(registry, central, () => fake("stg", [])) instanceof ClusterRouter);
});

test("ping is central's; connect survives a dead bridge", async () => {
  const { central, router } = setup({ failConnect: true });
  assert.equal(await router.ping(), true);
  await router.connect();
  assert.equal(central.connected, true);
});
