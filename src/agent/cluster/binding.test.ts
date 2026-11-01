import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterRegistry } from "./index.js";
import { clusterNote, parseClusterMention } from "./binding.js";

const names = ["dev", "stg"];
const registry = clusterRegistry({ localCluster: "dev", sqs: { clusters: [{ name: "stg", requestQueueName: "devops-mcp-stg-request.fifo" }] } });

test("a registry name as a whole word binds", () => {
  assert.deepEqual(parseClusterMention("cek pod di stg", names), { cluster: "stg", switch: false });
  assert.deepEqual(parseClusterMention("STG pods?", names), { cluster: "stg", switch: false });
  assert.deepEqual(parseClusterMention("<@U123> kenapa orders-api restart di dev?", names), { cluster: "dev", switch: false });
});

test("inside a longer word it does not", () => {
  assert.equal(parseClusterMention("restart devops-ai-agent", names), null);
  assert.equal(parseClusterMention("stg-backup job failed", names), null);
  assert.equal(parseClusterMention("the dev.annasik.cloud ingress", names), null);
});

test("two clusters named bind neither", () => {
  assert.equal(parseClusterMention("bandingkan dev dan stg", names), null);
});

test("an explicit switch", () => {
  assert.deepEqual(parseClusterMention("pindah ke dev, cek hal yang sama", names), { cluster: "dev", switch: true });
  assert.deepEqual(parseClusterMention("switch to stg", names), { cluster: "stg", switch: true });
  assert.deepEqual(parseClusterMention("ganti ke cluster stg", names), { cluster: "stg", switch: true });
});

test("no registry, no binding", () => {
  assert.equal(parseClusterMention("cek pod di stg", []), null);
});

test("the note", () => {
  const bound = clusterNote({ cluster: "stg", reason: "bound" }, registry);
  assert.match(bound, /cluster="stg"/);
  assert.match(bound, /Kubernetes tools read cluster stg/);
  const unbound = clusterNote({ cluster: null, reason: "unbound" }, registry);
  assert.match(unbound, /no Kubernetes tools/);
  assert.match(unbound, /dev, stg/);
  const unlabelled = clusterNote({ cluster: null, reason: "unlabelled" }, registry);
  assert.match(unlabelled, /no `cluster` label/);
  assert.match(unlabelled, /no Kubernetes tools/);
});
