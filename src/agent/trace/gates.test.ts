import { test } from "node:test";
import assert from "node:assert/strict";
import { DevOpsAgent } from "../index.js";
import { TraceRecorder } from "./index.js";
import type { EventRow } from "./store.js";
import type { LLMClient, LLMResponse } from "../llm/types.js";

// The loop's gates, recorded end to end through a real DevOpsAgent. The two cases are the log-gap
// nudge's two fates — the second one is the 2026-09-29 production failure (thread
// 1790690405.435999), which the Harness page exists to make visible.
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
const fakeMcp = () =>
  ({
    connect: async () => {},
    getTools: () => [
      { name: "k8s_list_pods", description: "list pods", input_schema: { type: "object", properties: {} } },
      { name: "k8s_get_pod_logs", description: "pod logs", input_schema: { type: "object", properties: {} } },
    ],
    callTool: async (name: string) =>
      name === "k8s_get_pod_logs"
        ? '{"logs":"' + "2026-10-01T03:01:16Z worker crashed: missing env DATABASE_URL\\n".repeat(6) + '"}'
        : '[{"name":"worker-6d9f8b7c5d-abcde","ready":false,"restarts":4,"status":"Running"}]',
    disconnect: async () => {},
  }) as any;
const agentWith = (llm: LLMClient) => {
  const rows: EventRow[] = [];
  const recorder = new TraceRecorder({ insert: async (r) => void rows.push(...r) }, { source: "bench", sha: "test" });
  return { agent: new DevOpsAgent({ llm, mcp: fakeMcp(), recorder }), rows };
};
const gates = (rows: EventRow[]) => rows.filter((e) => e.kind === "gate").map((e) => `${e.name}:${e.outcome}`);

const ALERT = "KubernetesPodCrashLooping: container worker in sample-apps is restarting in a loop (CrashLoopBackOff)";
const RCA =
  "*🔴 Severity:* `critical`\n\n*⚡ TL;DR*\n- worker crashloops on a missing env var\n\n" +
  "*🎯 Root Cause*\nworker exits at start: DATABASE_URL is not set\n\n" +
  "*🔧 Recommended Actions*\n1. *Immediate:* set DATABASE_URL on deployment `sample-apps/worker`\n\n" +
  "*📊 Confidence:* `Medium`";
const listPods: LLMResponse = { content: [{ type: "tool_use", id: "t1", name: "k8s_list_pods", input: { namespace: "sample-apps" } }], stopReason: "tool_use" };
const readLogs: LLMResponse = {
  content: [{ type: "tool_use", id: "t2", name: "k8s_get_pod_logs", input: { namespace: "sample-apps", pod_name: "worker-6d9f8b7c5d-abcde", previous: true, tail_lines: 200 } }],
  stopReason: "tool_use",
};
const say = (text: string): LLMResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

test("a crashloop answered without logs is nudged, and the retry's RCA is accepted", async () => {
  const { agent, rows } = agentWith(scripted([listPods, say(RCA), readLogs, say(RCA + "\nlogs: missing env DATABASE_URL")]));
  await agent.investigate("200.1", ALERT, { mode: "alert", trigger: ALERT, namespace: "sample-apps" });
  const g = gates(rows);
  assert.ok(g.includes("log-gap:nudge"), g.join(", "));
  assert.ok(g.includes("log-gap:accepted"), g.join(", "));
});

test("a retry that loses the RCA is recorded as kept-earlier", async () => {
  const { agent, rows } = agentWith(
    scripted([listPods, say(RCA), readLogs, say("Here are the last 10 log lines from the affected pod, as requested: ...")])
  );
  const answer = await agent.investigate("200.2", ALERT, { mode: "alert", trigger: ALERT, namespace: "sample-apps" });
  assert.match(answer, /Root Cause/, "the RCA was kept");
  const g = gates(rows);
  assert.ok(g.includes("nudge-lost-rca:kept"), g.join(", "));
  assert.ok(g.includes("log-gap:kept-earlier"), g.join(", "));
});
