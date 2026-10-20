import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Remediator } from "./remediator.js";
import { DevOpsAgent } from "../index.js";

// Housekeeping 2026-10-20: the remediation half of DevOpsAgent is its own class; the agent keeps a
// delegator per public method so app/, bench/ and replay/ call it unchanged.
const mcp = { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true };

test("Remediator is its own class and DevOpsAgent delegates to it", () => {
  assert.equal(typeof Remediator, "function");
  assert.ok((new DevOpsAgent({ mcp }) as any).remediator instanceof Remediator);
});

test("the host is read live: a store swapped after construction is the one the remediator uses", async () => {
  const agent = new DevOpsAgent({ mcp });
  let rejected: number | null = null;
  (agent as any).remediations = { reject: async (id: number) => { rejected = id; return true; } };
  assert.match(await agent.rejectRemediation(7, "U1"), /rejected by <@U1>/);
  assert.equal(rejected, 7);
});

test("agent/index.ts no longer holds the remediation bodies", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /private async (proposeGitOpsPr|executeGitOpsPr|resolveOverlayPath)\(/);
});
