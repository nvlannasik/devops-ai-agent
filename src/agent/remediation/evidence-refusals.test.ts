import { test } from "node:test";
import assert from "node:assert/strict";
import { targetKey } from "./evidence-refusals.js";

// targetKey is what makes "the same card" — RemediationStore.pendingFor matches on it, and the
// card's params.target is stored with it. Multi-cluster (agent/cluster): dev and stg can both
// have a `default/web` Deployment, so a cluster prefix is what keeps the two from colliding.
test("targetKey keeps single-cluster keys and prefixes the cluster", () => {
  assert.equal(targetKey("restart", "Default", "Web"), "restart:default/web");
  assert.equal(targetKey("restart", "default", "web", "stg"), "stg:restart:default/web");
  // no cluster, null cluster, and "" are all the same "without one" shape — single-cluster
  // callers (and an unbound/local one) must not see a key that changed shape under them.
  assert.equal(targetKey("restart", "default", "web", null), "restart:default/web");
  assert.equal(targetKey("restart", "default", "web", undefined), "restart:default/web");
});

// Bench C13, 2026-11-14, five of five: evicted for its ephemeral-storage limit, and a card raising MEMORY.
test("a resize for an ephemeral-storage eviction is refused — the action changes cpu and memory only", async () => {
  const { resourceFaultRefusal } = await import("./evidence-refusals.js");
  const p = (reason: string) => ({
    action: "k8s_set_resources", namespace: "bench-c13", name: "thumbnailer", reason,
    toolParams: { namespace: "bench-c13", name: "thumbnailer", memory_limit: "100Mi" }, summary: "",
  });
  const evicted = '{"name":"thumbnailer-6c9f7b8d5-x2k4q","reason":"Evicted","message":"Pod ephemeral local storage usage exceeds the total limit of containers 50Mi."}';
  assert.match(resourceFaultRefusal(p("Increase ephemeral-storage limit from 50Mi to 100Mi"), null) ?? "", /ephemeral-storage limit/);
  assert.match(resourceFaultRefusal(p("raise the limit"), evicted) ?? "", /cpu and memory only/);
  // a memory eviction on the same pod is a resize's business
  const memory = '{"name":"thumbnailer-6c9f7b8d5-x2k4q","reason":"Evicted","message":"The node was low on resource: memory. Container thumbnailer was using 300Mi, exceeding its memory limit"}';
  assert.equal(resourceFaultRefusal(p("raise the memory limit"), memory), null);
  assert.equal(resourceFaultRefusal(p("raise the memory limit"), `${evicted}\n${'thumbnailer OOMKilled exit code 137'}`), null);
});
