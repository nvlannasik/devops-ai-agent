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

// Clusters joined by a routed network (LAN, VPC peering) need no SQS bridge: the agent calls their
// MCP server over HTTP, as it calls its own. Live 2026-11-04: stg's IAM Roles Anywhere certificate
// expired and took the SQS bridge with it.
test("HTTP clusters join the registry beside the SQS ones, one name space for both", () => {
  const http = { name: "stg", url: "http://10.10.10.105:30300/mcp" };
  const r = clusterRegistry({ localCluster: "dev", sqs: { clusters: [] }, http: { clusters: [http] } });
  assert.equal(r.strict, true);
  assert.deepEqual(r.names, ["dev", "stg"]);
  assert.deepEqual(r.bridges, [http]);
  const prd = { name: "prd", requestQueueName: "devops-mcp-prd-request.fifo" };
  assert.deepEqual(clusterRegistry({ localCluster: "dev", sqs: { clusters: [prd] }, http: { clusters: [http] } }).names, ["dev", "prd", "stg"]);
  assert.throws(() => clusterRegistry({ localCluster: "dev", sqs: { clusters: [stg] }, http: { clusters: [http] } }), /both/);
  assert.throws(() => clusterRegistry({ localCluster: "stg", sqs: { clusters: [] }, http: { clusters: [http] } }), /MCP_LOCAL_CLUSTER/);
});
