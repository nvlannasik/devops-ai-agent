import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "../agent/index.js";
import { TraceRecorder } from "../agent/trace/index.js";
import type { EventRow } from "../agent/trace/store.js";
import type { LLMClient, LLMResponse } from "../agent/llm/types.js";
import { withTrace } from "../utils/trace/index.js";
import { selectRun, type Trace, type TraceEvent } from "./trace.js";
import { ReplayMCP } from "./fakes.js";
import { replay, score } from "./run.js";

// The proof the recording is complete (spec §9.1): run a real investigation against scripted
// clients with the recorder on, then replay what it recorded — same answer, same gates.

const scripted = (responses: LLMResponse[]): LLMClient => {
  let i = 0;
  return {
    chat: async () => {
      const r = responses[i++];
      if (!r) throw new Error("script exhausted");
      return r;
    },
  };
};
const POD = "worker-6d9f8b7c5d-abcde";
const fakeMcp = () =>
  ({
    connect: async () => {},
    getTools: () => [
      { name: "k8s_list_pods", description: "list pods", input_schema: { type: "object", properties: {} } },
      { name: "k8s_get_pod_logs", description: "pod logs", input_schema: { type: "object", properties: {} } },
      { name: "k8s_rollout_restart", description: "[WRITE] restart a workload", input_schema: { type: "object", properties: {} } },
    ],
    callTool: async (name: string, input: Record<string, unknown>) =>
      name === "k8s_get_pod_logs"
        ? '{"logs":"' + "2026-10-01T03:01:16Z worker crashed: missing env DATABASE_URL\\n".repeat(6) + '"}'
        : name === "k8s_rollout_restart"
          ? `Dry run: would restart deployment ${String(input.namespace)}/${String(input.name)}`
          : `[{"name":"${POD}","ready":true,"restarts":0,"status":"Running"}]`,
    disconnect: async () => {},
  }) as any;
const acceptAll = { pendingFor: async () => null, propose: async () => 1 } as any;

/** Runs the scripted investigation (and optionally the proposal) and returns what was recorded, as /api/trace would. */
async function record(script: LLMResponse[], opts: { proposal?: boolean } = {}): Promise<TraceEvent[]> {
  const rows: EventRow[] = [];
  const recorder = new TraceRecorder({ insert: async (r) => void rows.push(...r) }, { source: "bench", sha: "test" });
  const agent = new DevOpsAgent({ llm: scripted(script), mcp: fakeMcp(), recorder, remediations: acceptAll });
  const answer = await agent.investigate("300.1", ALERT, { mode: "alert", trigger: ALERT, namespace: "sample-apps" });
  if (opts.proposal) {
    await withTrace("300.1", () => agent.proposeRemediation(1, LABELS, answer, { threadId: "300.1" }));
  }
  return rows.map((r) => ({ thread_ts: r.threadTs, seq: r.seq, kind: r.kind, name: r.name, outcome: r.outcome, payload: r.payload }));
}
const gatesOf = (events: TraceEvent[]) => events.filter((e) => e.kind === "gate").map((e) => `${e.name}:${e.outcome}`);
const answerOf = (events: TraceEvent[], phase = "investigate") => {
  const runs = new Set(events.filter((e) => e.kind === "start" && e.payload.phase === phase && !e.thread_ts.includes("/sub-")).map((e) => e.payload.run));
  return events.find((e) => e.kind === "end" && runs.has(e.payload.run))?.payload.answer;
};

const ALERT = "KubernetesPodCrashLooping: container worker in sample-apps is restarting in a loop (CrashLoopBackOff)";
const LABELS = { alertname: "KubernetesPodCrashLooping", namespace: "sample-apps" };
const RCA =
  "*🔴 Severity:* `critical`\n\n*⚡ TL;DR*\n- worker crashloops on a missing env var\n\n" +
  "*🎯 Root Cause*\nworker exits at start: DATABASE_URL is not set\n\n" +
  "*🔧 Recommended Actions*\n1. *Immediate:* set DATABASE_URL on deployment `sample-apps/worker`\n\n" +
  "*📊 Confidence:* `Medium`";
const use = (id: string, name: string, input: Record<string, unknown>): LLMResponse => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" });
const say = (text: string): LLMResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const LOST_RCA = [
  use("t1", "k8s_list_pods", { namespace: "sample-apps" }),
  say(RCA),
  use("t2", "k8s_get_pod_logs", { namespace: "sample-apps", pod_name: POD, previous: true, tail_lines: 200 }),
  say("Here are the last 10 log lines from the affected pod, as requested: ..."),
];

test("round trip: a replay of a recorded run gives the same answer and the same gates", async () => {
  const events = await record(LOST_RCA);
  const r = await replay(selectRun(events), { mode: "gates" });
  assert.equal(r.outcome, "completed", r.where);
  assert.equal(r.answer, answerOf(events));
  assert.deepEqual(r.gates, gatesOf(events));
  assert.ok(r.gates.includes("nudge-lost-rca:kept"), "the fixture must exercise a nudge");
});

test("round trip with a delegate and a proposal that passed every gate", async () => {
  const events = await record(
    [
      use("d0", "delegate_investigation", { hypothesis: "worker exits on a missing env var in namespace sample-apps" }),
      use("s1", "k8s_get_pod_logs", { namespace: "sample-apps", pod_name: POD, tail_lines: 200 }), // the delegate
      say("SUPPORTED — the logs say DATABASE_URL is missing"), // the delegate's verdict
      say(RCA),
      say('{"action":"k8s_rollout_restart","namespace":"sample-apps","workload":"worker","reason":"stuck worker"}'),
    ],
    { proposal: true }
  );
  assert.ok(events.some((e) => e.thread_ts === "300.1/sub-1"), "the fixture must record a delegate");
  const recorded = answerOf(events, "proposal");
  assert.equal(recorded?.action, "k8s_rollout_restart", `the fixture's proposal must pass: ${JSON.stringify(recorded)}`);

  const r = await replay(selectRun(events), { mode: "gates" });
  assert.equal(r.outcome, "completed", r.where);
  assert.equal(r.answer, answerOf(events));
  assert.deepEqual(r.proposal, { action: "k8s_rollout_restart" });
  assert.deepEqual(r.gates, gatesOf(events));
});

test("a harness that asks for an answer the trace never gave diverges, and says where", async () => {
  const events = await record(LOST_RCA);
  const lastLlm = events.map((e) => e.kind).lastIndexOf("llm");
  const cut: Trace = selectRun(events.filter((_, i) => i !== lastLlm));
  const r = await replay(cut, { mode: "gates" });
  assert.equal(r.outcome, "diverged");
  assert.match(r.where ?? "", /LLM #4 on 300\.1/);
});

test("the same tool call twice is served in recorded order, and the last result repeats", async () => {
  const ev = (result: string): TraceEvent => ({ thread_ts: "1.1", seq: 0, kind: "tool", name: "k8s_list_pods", outcome: null, payload: { run: "a", input: { namespace: "x" }, result } });
  const trace: Trace = {
    thread: "1.1",
    events: [{ thread_ts: "1.1", seq: 0, kind: "start", name: null, outcome: null, payload: { run: "a", phase: "investigate", tools: [] } }, ev("first"), ev("second")],
  };
  const mcp = new ReplayMCP(trace, "gates");
  const call = () => withTrace("1.1", () => mcp.callTool("k8s_list_pods", { namespace: "x" }));
  assert.deepEqual([await call(), await call(), await call()], ["first", "second", "second"]);
  assert.equal(await withTrace("1.1", () => mcp.callTool("k8s_list_pods", { namespace: "other" })), "Error: not recorded in this trace (k8s_list_pods)");
  assert.match(mcp.divergedAt ?? "", /k8s_list_pods/);
});

test("score: answer regexes, gates, proposal, and divergence the case allows", () => {
  const r = { outcome: "completed" as const, answer: "Root Cause: missing env", gates: ["log-gap:nudge"], proposal: null };
  assert.equal(score(r, { answer: { must: ["root cause"], mustNot: ["as requested"] }, gates: { must: ["log-gap:nudge"] }, proposal: { action: null } }).outcome, "passed");
  const bad = score(r, { gates: { mustNot: ["log-gap:nudge"] }, proposal: { action: "k8s_rollout_restart" } });
  assert.equal(bad.outcome, "failed");
  assert.equal(bad.why.length, 2);
  assert.equal(score({ ...r, outcome: "diverged", where: "x" }, {}).outcome, "diverged");
  assert.equal(score({ ...r, outcome: "diverged", where: "x" }, { allowDiverge: true }).outcome, "passed");
  assert.equal(score({ ...r, outcome: "crashed", where: "boom" }, {}).outcome, "crashed");
});

// The experiment this exists for (2026-10-02): every production proposal in two days came from
// the light backend and every one was refused. Replaying the investigation from the recording and
// asking only the PROPOSAL of a live model compares proposal models on identical input, for the
// price of one or two LLM calls instead of a six-minute investigation.
test("live for the proposal only: the investigation is the recording, the proposal is the live model", async () => {
  const events = await record(
    [
      use("t1", "k8s_list_pods", { namespace: "sample-apps" }),
      say(RCA),
      use("t2", "k8s_get_pod_logs", { namespace: "sample-apps", pod_name: POD, previous: true, tail_lines: 200 }),
      say(RCA),
      say('{"action": null}'),
      say('{"action": null}'), // proposeWithRetry re-asks a null once
    ],
    { proposal: true }
  );
  const asked: string[] = [];
  const live: LLMClient = {
    chat: async (messages) => {
      asked.push(JSON.stringify(messages).slice(0, 40));
      return say('{"action":"k8s_rollout_restart","namespace":"sample-apps","workload":"worker","reason":"live model"}');
    },
  };
  const r = await replay(selectRun(events), { mode: "tools", live, livePhases: ["proposal"] });
  assert.equal(r.outcome, "completed", r.where);
  assert.equal(r.answer, answerOf(events), "the investigation must be the recorded one");
  assert.equal(asked.length, 1, "only the proposal reached the live model");
  // It passed every agent-side gate; the dry-run for an action the recording never ran is unknowable.
  assert.deepEqual(r.proposal, { action: "k8s_rollout_restart", dryRun: "unrecorded" });
});
