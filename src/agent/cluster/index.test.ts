import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterRegistry, withCluster, currentCluster, storedCluster } from "./index.js";

const stg = { name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" };

test("strict only when a registry is configured", () => {
  assert.equal(clusterRegistry({ localCluster: null, sqs: { clusters: [] } }).strict, false);
  assert.equal(clusterRegistry({ localCluster: "dev", sqs: { clusters: [] } }).strict, true);
  assert.equal(clusterRegistry({ localCluster: null, sqs: { clusters: [stg] } }).strict, true);
  assert.deepEqual(clusterRegistry({ localCluster: "dev", sqs: { clusters: [stg] } }).names, ["dev", "stg"]);
});

test("MCP_LOCAL_CLUSTER is validated like a bridge name", () => {
  assert.throws(() => clusterRegistry({ localCluster: "Dev", sqs: { clusters: [] } }), /MCP_LOCAL_CLUSTER/);
  assert.throws(() => clusterRegistry({ localCluster: "stg", sqs: { clusters: [stg] } }), /MCP_LOCAL_CLUSTER/);
});

test("withCluster sets and nests", async () => {
  assert.equal(currentCluster(), undefined);
  await withCluster("stg", async () => {
    assert.equal(currentCluster(), "stg");
    await withCluster("dev", async () => assert.equal(currentCluster(), "dev"));
    assert.equal(currentCluster(), "stg");
  });
  await withCluster(null, async () => assert.equal(currentCluster(), null));
  assert.equal(currentCluster(), undefined);
});

test("a NULL row reads as the local cluster", () => {
  const reg = clusterRegistry({ localCluster: "dev", sqs: { clusters: [stg] } });
  assert.equal(storedCluster(null, reg), "dev");
  assert.equal(storedCluster("stg", reg), "stg");
});
