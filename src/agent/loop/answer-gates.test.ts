import test from "node:test";
import assert from "node:assert/strict";
import { settleAnswer } from "./answer-gates.js";
import { newRunState, type RunCtx } from "./run-state.js";
import { NO_EVIDENCE_NOTICE } from "./control.js";
import { TraceRecorder } from "../trace/index.js";

const ctx: RunCtx = { threadId: "t1", mode: "alert", depth: 0, maxToolRounds: Infinity, maxIterations: 10,
  deadline: Date.now() + 60_000, startedAt: Date.now(), tools: [], systemPrompt: "", opts: {} };
const host = (appended: unknown[]) => ({
  memory: { append: async (_t: string, m: unknown) => void appended.push(m), get: async () => [] } as never,
  trace: () => new TraceRecorder(null, { source: "prod", sha: "t" }),
});
const reply = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn" }) as never;

test("an alert answered with zero tool calls is nudged once: null, and the notice is appended", async () => {
  const appended: unknown[] = [];
  const s = newRunState([]);
  s.iterations = 1;
  assert.equal(await settleAnswer(host(appended), ctx, s, reply("All fine.")), null);
  assert.equal(s.noEvidenceNudged, true);
  assert.deepEqual(appended, [{ role: "user", content: NO_EVIDENCE_NOTICE }]);
});

test("an empty final response is never returned empty", async () => {
  const s = newRunState([]);
  s.toolRounds = 1;
  const out = await settleAnswer(host([]), ctx, s, reply(""));
  assert.match(out!, /empty response/);
});
