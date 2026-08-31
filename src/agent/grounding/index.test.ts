import { test } from "node:test";
import assert from "node:assert/strict";
import { citedNames, groundingGaps, observedText } from "./index.js";
import type { Message } from "../llm/types.js";

const toolResult = (content: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "t1", content }],
});

const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

const toolCall = (name: string, input: Record<string, unknown>): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id: "t1", name, input }],
});

// The production regression, in full. The Service really existed; the Deployment behind it was
// derived from the Service's name and returned by nothing.
const SERVICES = toolResult(
  JSON.stringify([{ namespace: "default", name: "order-services-svc", endpoints: [] }])
);
const PODS = toolResult(
  JSON.stringify([
    { namespace: "sample-apps", name: "checkout-gateway-6b747db7c9-zwdcv", ready: false },
    { namespace: "sample-apps", name: "storefront-58c9f4d7b8-q2lkn", ready: true },
  ])
);

test("an invented workload derived from a real Service name is a gap", () => {
  const rca = "*📍 Root Cause*\nRestart `default/order-service` — its endpoints are empty.";
  assert.deepEqual(groundingGaps(rca, [SERVICES, PODS]), ["order-service"]);
});

// The trap a plain substring test falls into: "order-service" IS a prefix of
// "order-services-svc", so the invented name would be confirmed by the Service it came from.
test("a plain prefix of a real name does not count as grounded", () => {
  assert.deepEqual(groundingGaps("`order-service`", [SERVICES]), ["order-service"]);
  assert.deepEqual(groundingGaps("`order-services-svc`", [SERVICES]), []);
});

// The opposite trap: a Deployment is only ever seen as its pods' prefix, so demanding an exact
// token would flag every correctly-named workload in every RCA.
test("a workload named only through its pods is grounded", () => {
  assert.deepEqual(groundingGaps("`sample-apps/checkout-gateway` is failing", [PODS]), []);
});

test("a namespace-qualified name is checked in parts, and the namespace counts", () => {
  assert.deepEqual(citedNames("`sample-apps/orders-api`").sort(), ["orders-api", "sample-apps"]);
  assert.deepEqual(groundingGaps("`sample-apps/orders-api`", [PODS]), ["orders-api"]);
});

// Everything else the RCA format puts in backticks must never be treated as a resource name —
// each of these fails on a character it contains, which is what keeps the check quiet.
test("queries, metrics, selectors, quantities, timestamps and reasons are not names", () => {
  const noise =
    "`sum(rate(http_requests_total[5m]))` `http_request_duration_seconds_bucket` `app=nginx` " +
    "`512Mi` `98%` `2026-06-07T14:32:05Z` `CrashLoopBackOff` `504` `p99=450ms` `kubectl get pods`";
  assert.deepEqual(citedNames(noise), []);
});

// A bare word would be flagged over a wording difference rather than an invented resource.
test("bare words are not checked", () => {
  assert.deepEqual(citedNames("`storefront` `pending` `x`"), []);
});

// The check's first real firing was a false positive: `sample-apps` flagged in an RCA whose tools
// were all scoped to it by ARGUMENT, and whose bodies never repeated the namespace back.
test("a name the agent queried is grounded even when no result repeats it", () => {
  const history = [
    toolCall("k8s_list_events", { namespace: "sample-apps", since_minutes: 60 }),
    toolResult(JSON.stringify([{ reason: "Unhealthy", message: "Readiness probe failed" }])),
  ];
  assert.deepEqual(groundingGaps("probes failing in `sample-apps`", history), []);
});

// And the regression still has to fail: `order-service` was derived from a Service name and
// asserted in prose — it was never passed to any tool, which is what separates it from the above.
test("a name that was never queried and never returned is still a gap", () => {
  const history = [
    toolCall("k8s_get_endpoints", { namespace: "default", service: "order-services-svc" }),
    SERVICES,
  ];
  assert.deepEqual(groundingGaps("restart `default/order-service`", history), ["order-service"]);
});

// Letting the model's own prose count as evidence is how one hallucination confirms the next.
test("assistant text is not evidence", () => {
  const history = [assistant("the deployment `default/order-service` is wedged"), SERVICES];
  assert.equal(observedText(history).includes("order-service is wedged"), false);
  assert.deepEqual(groundingGaps("`default/order-service`", history), ["order-service"]);
});

test("an answer with no cited names, and an empty history, are both quiet", () => {
  assert.deepEqual(groundingGaps("no alerts are firing right now", [PODS]), []);
  assert.deepEqual(groundingGaps("check `sample-apps/checkout-gateway`", []), ["sample-apps", "checkout-gateway"]);
});

test("a name is reported once however often it is cited", () => {
  const rca = "`orders-api` failed; `orders-api` again; see `sample-apps/orders-api`";
  assert.deepEqual(groundingGaps(rca, [PODS]), ["orders-api"]);
});
