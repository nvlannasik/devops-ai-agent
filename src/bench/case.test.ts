import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "./case.js";

/** One case directory in a throwaway root, so a bad file fails here and not on a cluster. */
function caseDir(body: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "bench-cases-"));
  mkdirSync(join(root, String(body.id)));
  writeFileSync(join(root, String(body.id), "case.json"), JSON.stringify(body));
  return root;
}

const alertCase = {
  id: "A99-a-fault",
  tier: "A",
  title: "a fault",
  groupLabels: { alertname: "X", namespace: "bench-a99" },
  alerts: [{ labels: { alertname: "X" } }],
  expect: { action: null },
};

test("a case with no mode is an alert case, as every case written before the field assumed", () => {
  const cases = loadCases(caseDir(alertCase));
  assert.equal(cases[0].mode, "alert");
});

test("an alert case without an alert group does not load", () => {
  const { alerts: _drop, ...noAlerts } = alertCase;
  assert.throws(() => loadCases(caseDir(noAlerts)), /groupLabels \+ alerts/);
});

test("a conversation case without a message does not load", () => {
  assert.throws(
    () => loadCases(caseDir({ id: "C99-silent", tier: "C", title: "silent", mode: "conversation", expect: { action: null } })),
    /needs message/
  );
});

// Production reads the mode off the text, not off a file. A case that disagrees would be testing
// a path Slack never routes it down, and would go on doing so silently after any change to the
// classifier.
test("a case whose declared mode contradicts wantsInvestigation does not load", () => {
  const wrong = {
    id: "C99-mislabelled",
    tier: "C",
    title: "mislabelled",
    mode: "conversation",
    message: "investigate why the payments pods keep restarting",
    expect: { action: null },
  };
  assert.throws(() => loadCases(caseDir(wrong)), /routes its message to "investigation"/);
});

test("a conversation case whose message really is conversational loads", () => {
  const ok = {
    id: "C99-casual",
    tier: "C",
    title: "casual",
    mode: "conversation",
    message: "how is bench-c99 doing?",
    expect: { action: null },
  };
  assert.equal(loadCases(caseDir(ok))[0].mode, "conversation");
});
