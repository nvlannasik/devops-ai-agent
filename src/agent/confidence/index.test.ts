import { test } from "node:test";
import assert from "node:assert/strict";
import { capConfidence, parseConfidence } from "./index.js";

const rca = (confidence: string, body: string) =>
  `*🔴 Severity:* \`Critical\`\n\n*📍 Root Cause*\n${body}\n\n*📈 Confidence:* \`${confidence}\` — three sources agree`;

// C03: the container logs nothing, so "I could not see the evidence" and "I am sure" are the same
// sentence. The prompt asks for this (LOG_GAP_NOTICE); the small heavy model did not do it.
test("an answer reporting no logs cannot keep Confidence: High", () => {
  const { text, capped } = capConfidence(
    rca("High", "The worker container restarts at startup. No logs are available for the crashed instance."),
    false,
  );
  assert.equal(capped, true);
  assert.equal(parseConfidence(text), "medium");
  assert.match(text, /Confidence:\* `Medium` — the answer states the logs behind it were not available/);
  // the reasoning that supported High goes with it, rather than being left to contradict Medium
  assert.doesNotMatch(text, /three sources agree/);
});

test("the level is the only thing that changes — the rest of the RCA is untouched", () => {
  const before = rca("High", "Container `worker` produced no logs.");
  const { text } = capConfidence(before, false);
  assert.equal(text.split("\n").length, before.split("\n").length);
  assert.match(text, /\*📍 Root Cause\*\nContainer `worker` produced no logs\./);
});

// LOG_GAP_NOTICE: "Finding a healthy workload and quiet logs is a complete answer, not a thin one."
// Clean logs are evidence FOR the conclusion, so they must not cost the confidence.
test("clean logs are not a missing log", () => {
  for (const body of [
    "No error logs were found in the last hour; every probe passed.",
    "The logs show no errors and no restarts.",
    "Loki returned 412 lines, none above level=info.",
  ]) {
    assert.equal(capConfidence(rca("High", body), false).capped, false, body);
  }
});

test("a run that actually read logs keeps its rating, whatever the prose says", () => {
  // The claim is wrong and that is a different bug; hiding it behind a downgrade helps nobody.
  assert.equal(capConfidence(rca("High", "No logs were available."), true).capped, false);
});

test("Medium and Low are left alone — this gate only ever lowers High", () => {
  for (const level of ["Medium", "Low"]) {
    const before = rca(level, "No logs are available.");
    assert.deepEqual(capConfidence(before, false), { text: before, capped: false });
  }
});

test("the gap is recognised however the model words it, in either language", () => {
  for (const body of [
    "No log lines were returned for the affected pod.",
    "The container logs are unavailable — the instance was replaced.",
    "Pod logs came back empty for both the current and previous instance.",
    "I could not retrieve the logs for `bench-c03/worker`.",
    "The worker emitted no output before exiting.",
    "Tidak ada log yang bisa dibaca dari container tersebut.",
    "Log container-nya kosong sampai sekarang.",
  ]) {
    assert.equal(capConfidence(rca("High", body), false).capped, true, body);
  }
});

test("an answer with no confidence line at all is returned unchanged", () => {
  const plain = "No logs are available for that pod.";
  assert.deepEqual(capConfidence(plain, false), { text: plain, capped: false });
});
