import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterRegistry } from "./index.js";
import { clusterNote, clusterReply, parseClusterMention, speaksIndonesian } from "./binding.js";

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

test("an alert binds by its cluster label, and only to a registry cluster", async () => {
  const { alertCluster } = await import("./binding.js");
  assert.equal(alertCluster({ alertname: "X", cluster: "stg" }, registry), "stg");
  assert.equal(alertCluster({ alertname: "X" }, registry), null, "no label");
  assert.equal(alertCluster({ alertname: "X", cluster: "prd" }, registry), null, "a cluster the registry does not know");
  const single = clusterRegistry({ localCluster: null, sqs: { clusters: [] } });
  assert.equal(alertCluster({ alertname: "X", cluster: "stg" }, single), undefined, "single-cluster mode: nothing to bind");
});

test("cluster replies follow the user's language, wholly", () => {
  assert.equal(speaksIndonesian("pod mana yang restart?"), true);
  assert.equal(speaksIndonesian("unused resources on dev cluster"), false);
  assert.equal(speaksIndonesian("what current status?"), false);
  const names = ["dev", "stg"];
  const en = [clusterReply.which(names, false), clusterReply.other("stg", "dev", false), clusterReply.switched("stg", "dev", false)];
  const id = [clusterReply.which(names, true), clusterReply.other("stg", "dev", true), clusterReply.switched("stg", "dev", true)];
  for (const r of en) assert.equal(speaksIndonesian(r), false, `Indonesian word in English reply: ${r}`);
  for (const r of id) assert.equal(speaksIndonesian(r), true, r);
  // The suggested phrase must itself do what it says: bind, or switch.
  assert.deepEqual(parseClusterMention("on dev", names), { cluster: "dev", switch: false });
  assert.deepEqual(parseClusterMention("switch to dev", names), { cluster: "dev", switch: true });
  assert.deepEqual(parseClusterMention("pindah ke dev", names), { cluster: "dev", switch: true });
});
