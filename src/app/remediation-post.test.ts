import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";

// 2026-09-29, three checkout-gateway incidents: every thread ended in ":denied: *Remediation not
// proposed* — Setting the image to `registry.example.com/checkout-gateway:v1.2` is refused…",
// the gate explaining to on-call why it overruled a proposal nobody had asked for. A refusal of
// the MODEL's proposal is now logged, not posted; a refusal of a HUMAN's request is their answer
// and still posted. A card that survives every gate says "Remediation needed".
const run = async (outcome: unknown, userRequested: boolean) => {
  const posted: any[] = [];
  const notes: string[] = [];
  const gates: string[] = [];
  const self = {
    agent: {
      proposeRemediation: async () => outcome,
      noteInThread: async (_t: string, n: string) => void notes.push(n),
      recordCardMessage: async () => {},
      recordGate: (_t: string, name: string, out: string) => void gates.push(`${name}:${out}`),
    },
    app: { client: { chat: { postMessage: async (m: any) => (posted.push(m), { ts: "9.9" }) } } },
  };
  await (SlackApp.prototype as any).maybeProposeRemediation.call(self, "C1", "1.1", 42, {}, "rca", userRequested, null);
  return { posted, notes, gates };
};

test("a refused automatic proposal is not posted, and the agent still knows it was refused", async () => {
  const { posted, notes } = await run({ refused: "Setting the image to `x:v1.2` is refused" }, false);
  assert.equal(posted.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /REFUSED/);
});

test("a refused change the user asked for is still their answer", async () => {
  const { posted } = await run({ refused: "Namespace is not allowed" }, true);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /Remediation not proposed/);
});

test("a proposal that passed every gate is posted as remediation needed", async () => {
  const proposal = { summary: "rolling restart of `sample-apps/api`", reason: "stuck worker" };
  const { posted } = await run({ id: 7, proposal, dryRunSummary: "ok" }, false);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /^🔧 Remediation needed: rolling restart/);
});

// The proposal's fate reaches the Harness page as a gate (agent/trace).
test("each proposal outcome is recorded as a gate", async () => {
  assert.deepEqual((await run({ refused: "invented image" }, false)).gates, ["proposal:refused-hidden"]);
  assert.deepEqual((await run({ refused: "Namespace is not allowed" }, true)).gates, ["proposal:refused-posted"]);
  assert.deepEqual((await run({ id: 7, proposal: { summary: "rolling restart of `a/b`", reason: "x" }, dryRunSummary: "ok" }, false)).gates, ["proposal:posted"]);
  assert.deepEqual((await run(null, false)).gates, ["proposal:null"]);
});
