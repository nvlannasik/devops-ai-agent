import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeedbackJson, buildTranscript } from "./index.js";

test("parses a clean JSON object", () => {
  const out = parseFeedbackJson(
    '{"confirmed_root_cause": "DB pool exhausted", "action_taken": "scaled to 4 replicas", "outcome": "resolved"}'
  );
  assert.deepEqual(out, {
    confirmed_root_cause: "DB pool exhausted",
    action_taken: "scaled to 4 replicas",
    outcome: "resolved",
  });
});

test("tolerates prose and code fences around the JSON", () => {
  const out = parseFeedbackJson(
    'Here is the extraction:\n```json\n{"confirmed_root_cause": "OOM", "action_taken": null, "outcome": "mitigated"}\n```'
  );
  assert.equal(out?.confirmed_root_cause, "OOM");
  assert.equal(out?.outcome, "mitigated");
});

test("unknown or missing outcome normalizes to 'unknown'", () => {
  assert.equal(parseFeedbackJson('{"confirmed_root_cause": "x", "outcome": "Fixed!"}')?.outcome, "unknown");
  assert.equal(parseFeedbackJson('{"action_taken": "restarted"}')?.outcome, "unknown");
});

test("nothing substantive (or garbage) returns null", () => {
  assert.equal(parseFeedbackJson('{"confirmed_root_cause": null, "action_taken": "", "outcome": "resolved"}'), null);
  assert.equal(parseFeedbackJson("no json here at all"), null);
  assert.equal(parseFeedbackJson("{broken json"), null);
});

test("transcript labels humans vs agent and keeps the tail when too long", () => {
  const t = buildTranscript(
    [
      { user: "U1", text: "pods are crashing" },
      { bot_id: "B1", text: "RCA: probably OOM" },
      { user: "U2", text: "real cause was the connection pool, I scaled it" },
      { user: "U3", text: "   " }, // empty → dropped
    ],
    10_000
  );
  assert.match(t, /^user U1: pods are crashing\nagent: RCA: probably OOM\nuser U2: real cause/);
  assert.ok(!t.includes("U3"));

  const long = buildTranscript([{ user: "U1", text: "a".repeat(50) }, { user: "U2", text: "THE END" }], 20);
  assert.ok(long.endsWith("THE END"));
  assert.ok(long.length <= 20);
});
