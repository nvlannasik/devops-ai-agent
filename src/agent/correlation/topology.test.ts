import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { CALL_GRAPH_QUERY, parseCallGraph, relatedIncident, describeVia, serviceGraph, resetServiceGraphCache, type OpenIncident } from "./topology.js";

// The real shape returned by prometheus_query MCP tool: resultType and result at top level,
// optional note fields from explainEmptyVector if the result is empty
const VECTOR = JSON.stringify({
  resultType: "vector",
  result: [
    { metric: { namespace: "sample-apps", service: "checkout-gateway", peer: "orders-api" }, value: [1, "0.1"] },
    { metric: { namespace: "sample-apps", service: "storefront", peer: "checkout-gateway" }, value: [1, "0.3"] },
  ],
});
const VECTOR_WITH_ENVELOPE = JSON.stringify({
  status: "success",
  data: {
    resultType: "vector",
    result: [
      { metric: { namespace: "sample-apps", service: "checkout-gateway", peer: "orders-api" }, value: [1, "0.1"] },
      { metric: { namespace: "sample-apps", service: "storefront", peer: "checkout-gateway" }, value: [1, "0.3"] },
    ],
  },
});
const G = parseCallGraph(VECTOR)!;
const MIN = 60_000;
const T0 = Date.parse("2026-10-13T10:00:00Z");
const open = (over: Partial<OpenIncident> = {}): OpenIncident => ({ threadTs: "100.1", channel: "C1", alertname: "SampleAppHighLatency", namespace: "sample-apps", subjects: ["orders-api"], startedAt: T0, resolved: false, ...over });
const alert = (subjects: string[], at = T0 + 5 * MIN, namespace = "sample-apps") => ({ namespace, subjects, startsAt: at });

test("parseCallGraph reads the real shape (resultType/result at top level)", () => {
  assert.deepEqual(G["sample-apps"], [{ from: "checkout-gateway", to: "orders-api" }, { from: "storefront", to: "checkout-gateway" }]);
});

test("parseCallGraph defensively accepts the envelope form too", () => {
  const parsed = parseCallGraph(VECTOR_WITH_ENVELOPE);
  assert.deepEqual(parsed?.["sample-apps"], [{ from: "checkout-gateway", to: "orders-api" }, { from: "storefront", to: "checkout-gateway" }]);
});

test("parseCallGraph returns empty graph on empty result vector with note fields", () => {
  const empty = JSON.stringify({
    resultType: "vector",
    result: [],
    note: "no metrics matched the query",
  });
  const parsed = parseCallGraph(empty);
  assert.deepEqual(parsed, {}, "empty vector with note fields should parse as empty graph, not null");
});

test("parseCallGraph returns null for non-vector, error status, and invalid JSON", () => {
  assert.equal(parseCallGraph("Error: prometheus down"), null);
  assert.equal(parseCallGraph(JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })), null);
  assert.equal(parseCallGraph(JSON.stringify({ status: "error" })), null);
});

test("the query names the client-call metric and its service/peer labels", () => {
  assert.match(CALL_GRAPH_QUERY, /http_client_requests_total/);
  assert.match(CALL_GRAPH_QUERY, /by \(namespace, service, peer\)/);
});

test("relatedIncident matches the same service, the alert as caller, and the alert as callee", () => {
  assert.equal(relatedIncident(alert(["orders-api"]), [open()], G)?.via, "same-service");
  assert.deepEqual(relatedIncident(alert(["checkout-gateway"]), [open()], G)?.via, { from: "checkout-gateway", to: "orders-api" });
  assert.deepEqual(relatedIncident(alert(["orders-api"]), [open({ subjects: ["checkout-gateway"] })], G)?.via, { from: "checkout-gateway", to: "orders-api" });
});

test("relatedIncident refuses 2 hops, another namespace, >30 min, a later parent, resolved, and no subjects", () => {
  assert.equal(relatedIncident(alert(["storefront"]), [open()], G), null, "storefront → gateway → orders is two hops");
  assert.equal(relatedIncident(alert(["orders-api"], T0 + 5 * MIN, "other"), [open()], G), null);
  assert.equal(relatedIncident(alert(["orders-api"], T0 + 31 * MIN), [open()], G), null);
  assert.equal(relatedIncident(alert(["orders-api"], T0 - MIN), [open()], G), null, "a parent that started after the alert");
  assert.equal(relatedIncident(alert(["orders-api"]), [open({ resolved: true })], G), null);
  assert.equal(relatedIncident(alert([]), [open()], G), null);
});

test("relatedIncident: the latest matching parent wins", () => {
  const r = relatedIncident(alert(["orders-api"]), [open({ threadTs: "old", startedAt: T0 - 10 * MIN }), open({ threadTs: "new", startedAt: T0 })], G);
  assert.equal(r?.incident.threadTs, "new");
});

test("describeVia", () => {
  assert.equal(describeVia("same-service"), "same service");
  assert.equal(describeVia({ from: "a", to: "b" }), "a → b");
});

test("serviceGraph caches a good graph for 5 minutes and never caches a failure", async () => {
  resetServiceGraphCache();
  let calls = 0;
  let fail = true;
  const callTool = async () => { calls++; if (fail) throw new Error("timeout"); return VECTOR; };
  assert.equal(await serviceGraph(callTool, () => T0), null);
  fail = false;
  assert.ok(await serviceGraph(callTool, () => T0));
  await serviceGraph(callTool, () => T0 + 4 * MIN);
  assert.equal(calls, 2, "cached inside 5 min");
  await serviceGraph(callTool, () => T0 + 6 * MIN);
  assert.equal(calls, 3, "expired after 5 min");
});

test("CALL_GRAPH_QUERY metric exists in the sample apps", async (t) => {
  // Cross-repo check: verify http_client_requests_total with service and peer labels
  // exists in the real metric contract, resolved from this test file.
  const metricsPath = resolve(fileURLToPath(new URL("../../../../devops-sample-apps/packages/platform/src/metrics.ts", import.meta.url)));

  // Skip if the sibling repo is not present (single-repo CI)
  let content: string;
  try {
    content = fs.readFileSync(metricsPath, "utf-8");
  } catch {
    t.skip("sibling repo absent");
    return;
  }

  // Verify the metric name and its labels exist
  assert.match(content, /http_client_requests_total/, "metric http_client_requests_total must exist");
  assert.match(content, /labelNames:.*service.*peer/s, "metric must have service and peer labels");
});
