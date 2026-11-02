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
