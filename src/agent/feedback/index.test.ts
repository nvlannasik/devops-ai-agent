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

// --- incident 208, 2026-10-03: "learn dihiraukan aja untuk saat ini" ("ignore learn for now")
// ran learn, and with no human statement in the thread the extraction stored the AGENT's own
// hallucinated RCA ("workload-cert was renewed … not reloaded") in the human-confirmed tier. The
// next investigation recalled it as fact. Three guards, each deterministic.
test("a learn mention that declines or defers does not learn", async () => {
  const { learnIntent } = await import("./index.js");
  for (const t of ["learn dihiraukan aja untuk saat ini", "learn nanti aja", "learn abaikan", "learn: ignore this one", "learn skip", "learn jangan dulu"]) {
    assert.equal(learnIntent(t), "declined", t);
  }
  for (const t of ["learn", "learn: the db pool was exhausted, we raised max_connections", "Learn — root cause was a bad image tag"]) {
    assert.equal(learnIntent(t), "learn", t);
  }
});

test("only humans' own words are evidence — not the bot, not the learn command", async () => {
  const { humanStatements } = await import("./index.js");
  const thread = [
    { ts: "1", bot_id: "B1", text: "*🎯 Root Cause*\nworkload-cert was renewed but not reloaded" },
    { ts: "2", user: "U1", text: "<@U0AGENT> learn dihiraukan aja untuk saat ini" },
  ];
  assert.deepEqual(humanStatements(thread, "2"), [], "incident 208: nothing a human stated");
  const withFix = [...thread, { ts: "3", user: "U2", text: "fixed it: the gateway had ORDER_RESPONSE_VERSION=2, set back to 1" }];
  assert.deepEqual(humanStatements(withFix, "2"), ["fixed it: the gateway had ORDER_RESPONSE_VERSION=2, set back to 1"]);
  assert.deepEqual(humanStatements([{ ts: "4", user: "U1", text: "ok" }], "x"), [], "an acknowledgement is not a statement");
});

test("a ✅ on a message endorses it, whoever wrote it", async () => {
  const { humanStatements } = await import("./index.js");
  const thread = [{ ts: "1", bot_id: "B1", text: "Restarted orders-api after raising its memory limit to 512Mi" }];
  assert.deepEqual(humanStatements(thread, null, "1"), ["Restarted orders-api after raising its memory limit to 512Mi"]);
});

test("an extracted cause whose names appear only in the bot's messages is dropped", async () => {
  const { tracesToHumans } = await import("./index.js");
  const copied = { confirmed_root_cause: "Certificate workload-cert was renewed but workload-tls was not reloaded", action_taken: null, outcome: "unknown" as const };
  assert.equal(tracesToHumans(copied, "learn: looks fine to me"), null);
  const real = { confirmed_root_cause: "orders-api returned v2 bodies (ORDER_RESPONSE_VERSION=2)", action_taken: "set ORDER_RESPONSE_VERSION back to 1", outcome: "resolved" as const };
  assert.deepEqual(tracesToHumans(real, "it was ORDER_RESPONSE_VERSION=2 on orders-api, set it back to 1"), real);
  const prose = { confirmed_root_cause: "the database was down for maintenance", action_taken: null, outcome: "resolved" as const };
  assert.deepEqual(tracesToHumans(prose, "db maintenance window, it was down"), prose, "nothing to check a prose cause against — kept");
  const half = { confirmed_root_cause: "workload-cert was renewed", action_taken: "raised orders-api memory to 512Mi", outcome: "mitigated" as const };
  assert.deepEqual(tracesToHumans(half, "we raised memory on orders-api to 512Mi"), { ...half, confirmed_root_cause: null });
});
