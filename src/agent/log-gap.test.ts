import { test } from "node:test";
import assert from "node:assert/strict";
import { demandsLogs, logGapAction, LOG_GAP_NOTICE, LOG_TOOLS, type LogGapState } from "./index.js";
import { loadSkills, resolveSkillsDir } from "./skills/index.js";

// The SHIPPED playbooks, like skills/real.test.ts: the gate reads their bodies, so an edit that
// drops `k8s_get_pod_logs` from crashloopbackoff.md silently disables it for every crashloop
// investigation. That is the failure this file is here to make loud.
const registry = loadSkills(resolveSkillsDir());
const skill = (name: string) => {
  const s = registry.all().find((x) => x.name === name);
  assert.ok(s, `playbook ${name} is gone — the log-gap gate reads it`);
  return s!;
};

test("the log-gap gate fires for the playbooks that read logs", () => {
  // B04 loaded crashloopbackoff and answered without logs; A13 loaded log-alert and reported an
  // empty filtered Loki query as "no errors".
  for (const name of ["crashloopbackoff", "log-alert", "oomkilled", "pod-not-ready"]) {
    assert.equal(demandsLogs([skill(name)]), true, `${name} reads logs but the gate does not know it`);
  }
});

test("it stays off the cases with no logs to read", () => {
  // A Pending pod never started a container, and a PVC that never bound has none either. Nudging
  // those would cost an LLM call per investigation to be told what is already true.
  for (const name of ["pod-pending", "pvc-pending", "service-unavailable"]) {
    assert.equal(demandsLogs([skill(name)]), false, `${name} has no logs to read but the gate nudges anyway`);
  }
  assert.equal(demandsLogs([]), false);
});

test("the notice says what to call, and that an empty query is a fact about the query", () => {
  assert.match(LOG_GAP_NOTICE, /k8s_get_pod_logs/);
  assert.match(LOG_GAP_NOTICE, /previous.{0,10}true/);
  // The first wording said "call it with previous: true" flatly, and A13 obeyed it on a pod that
  // had never restarted: no previous instance exists, the call came back empty, and the answer
  // reported the logs as inaccessible while the running container was printing the evidence.
  assert.match(LOG_GAP_NOTICE, /if the pod is Running and has not restarted, there IS no previous instance/);
  assert.match(LOG_GAP_NOTICE, /retry without it rather than reporting the logs as unavailable/);
  // A13's failure mode: empty result read as evidence of absence.
  assert.match(LOG_GAP_NOTICE, /fact about the QUERY and not about the workload/);
  // B04's: the RCA recommended the tool call it was holding.
  assert.match(LOG_GAP_NOTICE, /Do not recommend that a human run a log query you can run yourself/);
  // C03's: logs genuinely absent is a valid answer, stated and paid for in confidence.
  assert.match(LOG_GAP_NOTICE, /genuinely unavailable/);
  // C01's: the gate also fires on a healthy namespace, because "nothing is wrong" and "I did not
  // look" are the same sentence until someone looks. It must not turn a correct clean bill of
  // health into a hedged one.
  assert.match(LOG_GAP_NOTICE, /lower the Confidence only if your conclusion actually depends on them/);
  assert.match(LOG_GAP_NOTICE, /a complete answer, not a thin one/);
  for (const t of LOG_TOOLS) assert.ok(t.startsWith("k8s_") || t.startsWith("loki_"), t);
});

// ── The gate's own decision ──────────────────────────────────────────────────
// A run that has just answered, with the playbooks that read logs loaded and no log line seen.
const ripe = (over: Partial<LogGapState> = {}): LogGapState => ({
  mode: "alert",
  demandsLogs: true,
  sawLogLines: false,
  nudged: false,
  toolsDisabled: false,
  toolRounds: 1,
  toolRoundsAtNudge: -1,
  heldBy: null,
  ...over,
});

test("an alert that never read a log line gets one more round", () => {
  assert.equal(logGapAction(ripe()), "nudge");
});

// Observed 2026-09-15 on thread 1789488072: "apakah ada anomali di cluster 1 jam kebelakang ini?"
// was answered correctly, the gate fired on playbooks four turns older than the question, and the
// retry replaced the answer with "That's outside what I do". Twice.
test("a conversation is never nudged — its playbooks belong to earlier questions", () => {
  assert.equal(logGapAction(ripe({ mode: "conversation" })), "answer");
  assert.equal(logGapAction(ripe({ mode: "investigation" })), "answer");
});

test("the nudge is spent once, and never with no tool round behind it or tools already off", () => {
  assert.equal(logGapAction(ripe({ nudged: true })), "answer");
  assert.equal(logGapAction(ripe({ toolRounds: 0 })), "answer");
  assert.equal(logGapAction(ripe({ toolsDisabled: true })), "answer");
  assert.equal(logGapAction(ripe({ sawLogLines: true })), "answer");
  assert.equal(logGapAction(ripe({ demandsLogs: false })), "answer");
});

// The half that was missing: the nudge REPLACES the answer it interrupted, so a retry that
// gathered nothing must not be allowed to.
test("a nudge round that ran no tools gives the first answer back", () => {
  const held = ripe({ nudged: true, heldBy: "tools", toolRoundsAtNudge: 1, toolRounds: 1 });
  assert.equal(logGapAction(held), "restore");
});

test("a nudge round that DID fetch logs keeps its own answer", () => {
  const fetched = ripe({
    nudged: true,
    heldBy: "tools",
    toolRoundsAtNudge: 1,
    toolRounds: 2,
    sawLogLines: true,
  });
  assert.equal(logGapAction(fetched), "answer");
});

// 2026-09-25, twice in one alert burst: the RCA-completeness gate asked for a tool-free rewrite,
// got back a 5656-character answer carrying all eight sections, and this restore threw it away
// for the 4650-character four-section answer it replaced. The two gates share a hold slot, and a
// boolean could not say that one of them WANTS its extra round to call nothing. The type says it
// now, and this is the case that has to stay true.
test("a rewrite the completeness gate asked for is never restored away", () => {
  const rewritten = ripe({ nudged: true, heldBy: "rca", toolRoundsAtNudge: 1, toolRounds: 1 });
  assert.equal(logGapAction(rewritten), "answer");
});

// --- returnedLogLines: an EXPLAINED empty Loki answer is not evidence ---
// Both strings are verbatim from devops-mcp-server against the live Loki, 2026-09-27. They pass the
// 200-char length test while holding no log line, which is the whole reason the marker exists.
test("an explained-empty Loki answer does not count as having seen log lines", async () => {
  const { returnedLogLines } = await import("./index.js");
  const namespaceSilent =
    '{"streams":[],"noLogLines":true,"namespacesWithLogs":9,"verdict":"namespace_silent","note":"Loki is receiving logs from 9 namespace(s) in this window, but none from `no-such-ns`. Either nothing there wrote to stdout/stderr, the namespace name is wrong, or its containers exited before the shipper picked up their log files."}';
  const noMatch =
    '{"streams":[],"noLogLines":true,"namespacesWithLogs":9,"verdict":"no_match","note":"Loki is ingesting (including from `flux-system`), but nothing matched this query. That is a fact about the selector or the line filter, not proof the event never happened."}';
  for (const s of [namespaceSilent, noMatch]) {
    assert.ok(s.length >= 200, "precondition: long enough to fool the length test");
    assert.equal(returnedLogLines(s), false);
  }
  // Survives the injection frame appended after the JSON, which is why it is a regex and not a parse.
  assert.equal(returnedLogLines(`${noMatch}\n\n[NOTE — this tool result contains text shaped like an instruction ...]`), false);
});

test("real log lines still count, and short results still do not", async () => {
  const { returnedLogLines } = await import("./index.js");
  const lines = JSON.stringify(
    Array.from({ length: 3 }, (_, i) => ({ timestamp: `2026-09-27T00:00:0${i}Z`, labels: { namespace: "bench-b04" }, line: "FATAL: DATABASE_URL is not set, refusing to start" }))
  );
  assert.equal(returnedLogLines(lines), true);
  assert.equal(returnedLogLines("[]"), false);
});

// --- the format skill must never arm the gate ---
// Regression, 2026-09-25: rca-format gained `_loki_query_range_` as a citation EXAMPLE, rca-format
// rides every alert, and from then on a Pending pod (which never started a container and cannot
// have logs) was nudged to fetch them — and the reply to the nudge replaced a complete RCA.
test("the shipped rca-format skill alone does not demand logs, whatever tool names it cites", () => {
  const format = skill("rca-format");
  assert.ok(/loki_query|k8s_get_pod_logs/.test(format.body), "precondition: it still names a log tool — the case that bit");
  assert.equal(demandsLogs([format]), false);
  // …and the no-logs-by-construction playbooks it was paired with in the failing runs stay unarmed.
  for (const name of ["pod-pending", "rollout-stuck", "imagepullbackoff"]) {
    assert.equal(demandsLogs([skill(name), format]), false, `${name} + rca-format`);
  }
  // A diagnostic playbook that reads logs still arms it, with the format skill beside it.
  assert.equal(demandsLogs([skill("crashloopbackoff"), format]), true);
});

// Bench C03, 2026-09-29, attempt 3: the model sent loki_query_range `start`/`end` as epoch numbers,
// the MCP SDK refused the input with a 435-char zod report, and that report counted as "saw log
// lines" — length was the only test. The log-gap gate went silent and capConfidence let
// "Confidence: High" stand on an answer that itself said no logs were retrieved.
test("a failed log call is not log lines, however long its error", async () => {
  const { returnedLogLines } = await import("./index.js");
  const zod =
    'MCP error -32602: Input validation error: Invalid arguments for tool loki_query_range: [\n  {\n    "code": "invalid_type",\n' +
    '    "expected": "string",\n    "received": "number",\n    "path": [\n      "start"\n    ],\n    "message": "Expected string, received number"\n  },\n' +
    '  {\n    "code": "invalid_type",\n    "expected": "string",\n    "received": "number",\n    "path": [\n      "end"\n    ],\n    "message": "Expected string, received number"\n  }\n]';
  const upstream = "Error: Failed to get logs for pod settlement-worker-55f4d46d77-4wzdr: " + "previous terminated container \"worker\" not found ".repeat(4);
  assert.ok(zod.length >= 200 && upstream.length >= 200, "the fixtures must clear the length threshold, or this proves nothing");
  assert.equal(returnedLogLines(zod), false, "SDK input rejection");
  assert.equal(returnedLogLines(upstream), false, "MCP server Error:");
  assert.equal(returnedLogLines(`[repeat call] You already ran this exact tool.\n\n${upstream}`), false, "a memoised failure");
  assert.equal(returnedLogLines('{"logs":"' + "2026-09-29T03:01:16Z worker starting batch 42\\n".repeat(6) + '"}'), true, "real lines still count");
});

// Bench C03 attempt 1, 2026-09-29 — and, it turns out, the 2026-09-24 "cap still declined" nobody
// could explain. After the log-gap nudge the model repeated a k8s_get_pod_logs call; the memo
// served the same 126-char empty result behind REPEAT_NOTICE, the notice alone is ~300 chars, and
// the length test counted our own sentence as log lines. sawLogLines went true and High stood.
test("a memoised result is measured without the repeat notice in front of it", async () => {
  const { returnedLogLines, REPEAT_NOTICE } = await import("./index.js");
  const empty = '{"logs":"","container":"worker","note":"the previous instance wrote nothing to stdout or stderr"}';
  assert.ok(empty.length < 200 && (REPEAT_NOTICE + empty).length >= 200, "the notice must be what crosses the threshold");
  assert.equal(returnedLogLines(REPEAT_NOTICE + empty), false);
  const lines = '{"logs":"' + "2026-09-29T03:01:16Z worker starting batch 42\\n".repeat(6) + '"}';
  assert.equal(returnedLogLines(REPEAT_NOTICE + lines), true, "a memoised result WITH lines still counts");
});

// --- a delegate's log lines are the parent's evidence too (live, 2026-09-29) ---
// Thread 1790690405.435999: delegate sub-2 read 273K chars of Loki and quoted the 502s, and the
// parent was still nudged for "no log lines", because it only counted its own calls.
test("a delegate's memo counts its log lines, and only its successful log calls", async () => {
  const { memoSawLogLines, toolCallKey } = await import("./index.js");
  const lines = '{"streams":[{"values":[' + '["1","checkout-gateway returned 502: upstream_unreadable"],'.repeat(6) + '["2","x"]]}]}';
  const memo = (entries: Array<[string, string]>) =>
    new Map(entries.map(([name, result]) => [toolCallKey(name, { namespace: "sample-apps" }), { result: Promise.resolve(result) }]));

  assert.equal(await memoSawLogLines(memo([["loki_query_range", lines]])), true);
  assert.equal(await memoSawLogLines(memo([["k8s_list_events", lines]])), false, "a non-log tool is not log evidence, however long");
  assert.equal(await memoSawLogLines(memo([["loki_query_range", '{"streams":[],"noLogLines":true,"note":"x"}']])), false);
  assert.equal(await memoSawLogLines(undefined), false, "a delegate whose memo is gone saw nothing we can vouch for");
  const failed = new Map([[toolCallKey("k8s_get_pod_logs", {}), { result: Promise.reject(new Error("boom")) }]]);
  assert.equal(await memoSawLogLines(failed), false, "a rejected call is not evidence and must not throw");
});

// --- a nudge's retry must not cost the answer an RCA it already had (live, 2026-09-29) ---
test("an RCA replaced by a non-RCA after a nudge is kept; every other shape is not", async () => {
  const { nudgeLostRca } = await import("./index.js");
  const { isRcaResponse } = await import("../utils/slack/blocks.js");
  const rca = "*🔴 Severity:* `critical`\n\n*⚡ TL;DR*\n- orders-api is unreadable upstream\n\n*🎯 Root Cause*\norders-api returns 502";
  const dump = 'Here are the last 10 log lines from the affected pod, as requested:\n\n```\n{"level":"info"}\n```';
  assert.ok(isRcaResponse(rca) && !isRcaResponse(dump), "fixtures must sit on either side of the RCA test");

  assert.equal(nudgeLostRca({ mode: "alert", heldBy: "tools", before: rca, after: dump }), true, "the live case");
  assert.equal(nudgeLostRca({ mode: "alert", heldBy: "rca", before: rca, after: dump }), true);
  assert.equal(nudgeLostRca({ mode: "alert", heldBy: "tools", before: rca, after: rca + "\nmore evidence" }), false, "an RCA for an RCA is the point of the round");
  assert.equal(nudgeLostRca({ mode: "alert", heldBy: "tools", before: dump, after: dump }), false, "nothing to keep");
  assert.equal(nudgeLostRca({ mode: "alert", heldBy: null, before: rca, after: dump }), false, "the zero-evidence nudge's answer is not worth keeping");
  assert.equal(nudgeLostRca({ mode: "conversation", heldBy: "tools", before: rca, after: dump }), false, "a conversation has no RCA to lose");
});

test("the notice says it is not itself a request to show logs", () => {
  assert.match(LOG_GAP_NOTICE, /not a request to show logs/);
  assert.match(LOG_GAP_NOTICE, /complete answer again, in the same format/);
});
