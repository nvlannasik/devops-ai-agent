import test from "node:test";
import assert from "node:assert/strict";
import { IncidentLifecycle } from "./lifecycle.js";
import { DevOpsAgent } from "../index.js";

const mcp = { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true };

// Same guard as remediator.test.ts (8c60b0a): a real agent, every target stubbed, so a delegator
// that calls itself overflows here instead of in production.
test("every DevOpsAgent delegator reaches the IncidentLifecycle, not itself", async () => {
  const agent = new DevOpsAgent({ mcp });
  const l = (agent as any).lifecycle;
  assert.ok(l instanceof IncidentLifecycle);
  const reached: string[] = [];
  for (const name of Object.getOwnPropertyNames(IncidentLifecycle.prototype)) {
    if (name === "constructor") continue;
    l[name] = async () => { reached.push(name); return null; };
    await (agent as any)[name]();
  }
  assert.deepEqual(reached.sort(), ["learnFromThread", "runIncidentReconcile", "setIncidentStatus"]);
});

test("the host is read live: an incident store swapped after construction is the one used", async () => {
  const agent = new DevOpsAgent({ mcp });
  (agent as any).incidents = { findIncidentByThread: async () => null };
  assert.match(await agent.learnFromThread("C", "1.1", "U", "2.2", "t", "h"), /isn't linked/);
});
