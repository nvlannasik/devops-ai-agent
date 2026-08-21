import { test } from "node:test";
import assert from "node:assert/strict";
import { namespacesOf, outOfScope } from "./index.js";
import type { ContentBlock } from "../llm/types.js";

const call = (name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: "tool_use", id: `id-${name}-${JSON.stringify(input)}`, name, input }) as ContentBlock;

test("first round defines the namespace scope", () => {
  const scope = namespacesOf([call("k8s_list_pods", { namespace: "nginx-ingress" }), call("alertmanager_get_alerts", {})]);
  assert.deepEqual([...scope], ["nginx-ingress"]);
});

test("drifting into another namespace is flagged; in-scope and namespace-less calls are not", () => {
  const scope = new Set(["nginx-ingress"]);
  const drift = call("k8s_list_pods", { namespace: "monitoring" });
  const inScope = call("k8s_get_pod_logs", { namespace: "nginx-ingress", pod_name: "x" });
  const nsLess = call("alertmanager_get_alerts", {});
  assert.deepEqual(outOfScope([drift, inScope, nsLess], scope), [drift]);
});

test("an empty scope (namespace-less question) disables the lock", () => {
  assert.deepEqual(outOfScope([call("k8s_list_pods", { namespace: "anything" })], new Set()), []);
});
