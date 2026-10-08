import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "./index.js";

// The kind gate's wiring (bench B04): the proposed kind's listing is read first and, when it holds
// the name, it is the ONLY read — that is the call a recorded run already has, so replay stays put.

const fakeMcp = (listings: Record<string, string>, calls: string[]) => ({
  callTool: async (tool: string) => {
    calls.push(tool);
    return listings[tool] ?? "[]";
  },
});
const setImage = (kind?: string) => ({
  action: "k8s_set_image",
  toolParams: { namespace: "bench-b04", name: "payments", image: "busybox:1.36", ...(kind ? { kind } : {}) },
});
const sts = JSON.stringify([{ name: "payments", containers: [{ name: "api", image: "busybox:1.36" }] }]);

test("a StatefulSet proposed as a Deployment is refused, after reading the other kinds", async () => {
  const calls: string[] = [];
  const r = await DevOpsAgent.prototype.kindRefusalFor.call(
    { mcp: fakeMcp({ k8s_list_statefulsets: sts }, calls) } as never,
    setImage("deployment") as never
  );
  assert.match(r ?? "", /is a StatefulSet, not a Deployment/);
  assert.equal(calls[0], "k8s_list_deployments", "the proposed kind first");
  assert.deepEqual([...calls].sort(), ["k8s_list_daemonsets", "k8s_list_deployments", "k8s_list_statefulsets"]);
});

test("the right kind costs one read and refuses nothing", async () => {
  const calls: string[] = [];
  const r = await DevOpsAgent.prototype.kindRefusalFor.call(
    { mcp: fakeMcp({ k8s_list_statefulsets: sts }, calls) } as never,
    setImage("statefulset") as never
  );
  assert.equal(r, null);
  assert.deepEqual(calls, ["k8s_list_statefulsets"]);
});

test("a listing that cannot be read refuses nothing", async () => {
  const r = await DevOpsAgent.prototype.kindRefusalFor.call(
    { mcp: { callTool: async () => { throw new Error("timeout"); } } } as never,
    setImage() as never
  );
  assert.equal(r, null);
});
