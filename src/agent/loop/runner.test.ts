import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InvestigationRunner } from "./runner.js";
import { DevOpsAgent } from "../index.js";

const mcp = { connect: async () => {}, disconnect: async () => {}, getTools: () => [], callTool: async () => "", ping: async () => true };

test("investigate() reaches the runner", async () => {
  const agent = new DevOpsAgent({ mcp });
  const runner = (agent as any).runner;
  assert.ok(runner instanceof InvestigationRunner);
  let seen: string | null = null;
  runner.run = async (t: string) => { seen = t; return "ok"; };
  assert.equal(await agent.investigate("1.1", "q"), "ok");
  assert.equal(seen, "1.1");
});

// A delegate run that skipped investigate() would carry the parent's traceId and never be written.
test("a delegate goes through the host's investigate(), not the runner's own run()", async () => {
  const calls: string[] = [];
  const host = { investigate: async (t: string) => { calls.push(t); return "CONFIRMED — x"; },
    memory: { clear: async () => {} }, threadSkills: new Map(), trace: () => ({ gate: () => {} }) } as any;
  const r = new InvestigationRunner(host) as any;
  r.run = async () => { throw new Error("delegate must not call run() directly"); };
  const out = await r.runDelegates("1.1", [{ type: "tool_use", id: "d1", name: "delegate_investigation", input: { hypothesis: "h" } }], Date.now() + 600_000);
  assert.equal(calls.length, 1);
  assert.match(String(out.results[0].content), /CONFIRMED/);
});

test("agent/index.ts no longer holds the loop", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /private async (runInvestigation|runDelegates|executeToolCalls)\(/);
});
