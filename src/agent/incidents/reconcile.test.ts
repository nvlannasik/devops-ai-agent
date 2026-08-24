import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsReadable, decideReconcile, parseStatusCommand } from "./reconcile.js";
import { alertState } from "../remediation/verify.js";

const held = (alertname: string, namespace?: string, omitted?: number) =>
  JSON.stringify({
    summary: { groups: 1, alerts: 1 },
    groups: [{ groupLabels: { alertname }, alerts: [{ name: alertname, status: "active", labels: { alertname, ...(namespace ? { namespace } : {}) } }] }],
    ...(omitted ? { omitted } : {}),
  });

const empty = (omitted?: number) => JSON.stringify({ summary: { groups: 0, alerts: 0 }, groups: [], ...(omitted ? { omitted } : {}) });

const MINUTE = 60_000;
const T0 = Date.parse("2026-08-24T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("a cleared alert needs two passes before anything closes", () => {
  // first pass: nothing to compare against yet — remember the sighting, close nothing
  assert.equal(decideReconcile("cleared", null, 2 * MINUTE, T0), "confirming");
  // second pass, too soon — the window has not elapsed
  assert.equal(decideReconcile("cleared", iso(T0), 2 * MINUTE, T0 + MINUTE), "confirming");
  // second pass, window elapsed
  assert.equal(decideReconcile("cleared", iso(T0), 2 * MINUTE, T0 + 2 * MINUTE), "resolve");
});

test("an alert that comes back mid-confirmation resets, and never closes", () => {
  assert.equal(decideReconcile("firing", iso(T0), 2 * MINUTE, T0 + MINUTE), "reset");
  // after the reset the sighting is gone, so the next cleared reading starts over
  assert.equal(decideReconcile("cleared", null, 2 * MINUTE, T0 + 2 * MINUTE), "confirming");
});

test("no evidence is never read as recovery", () => {
  // Alertmanager unreadable, and "no alertname to ask about" — both inert, both would
  // otherwise close an incident on the strength of a failed tool call
  assert.equal(decideReconcile("unknown", iso(T0), 2 * MINUTE, T0 + MINUTE), "skip");
  assert.equal(decideReconcile("none", iso(T0), 2 * MINUTE, T0 + MINUTE), "skip");
  assert.equal(decideReconcile("firing", null, 2 * MINUTE, T0), "skip");
  // an unparseable stored timestamp restarts the clock rather than resolving on NaN
  assert.equal(decideReconcile("cleared", "not-a-date", 2 * MINUTE, T0), "confirming");
});

test("a truncated or unreadable alert response is not usable evidence", () => {
  assert.equal(alertsReadable(empty()), true);
  assert.equal(alertsReadable(held("KubePodCrashLooping")), true);
  // absence is the recovery signal, so a capped response could hide the alert that paged
  assert.equal(alertsReadable(empty(12)), false);
  assert.equal(alertsReadable(held("KubePodCrashLooping", "payments", 3)), false);
  assert.equal(alertsReadable("not json"), false);
  assert.equal(alertsReadable(JSON.stringify({ summary: {} })), false);
});

test("end to end: a held alert stays open, a gone one closes after the window", () => {
  const alertname = "KubePodCrashLooping";
  const stillFiring = alertState(held(alertname, "payments"), alertname, "payments");
  assert.equal(decideReconcile(stillFiring, iso(T0), 2 * MINUTE, T0 + 10 * MINUTE), "reset");

  const gone = alertState(empty(), alertname, "payments");
  assert.equal(decideReconcile(gone, iso(T0), 2 * MINUTE, T0 + 10 * MINUTE), "resolve");
});

test("on-call status command reads both languages", () => {
  for (const t of ["resolved", "fixed", "selesai", "beres", "aman", "sudah beres", "udah selesai"]) {
    assert.equal(parseStatusCommand(t), "resolved", t);
  }
  for (const t of ["reopen", "re-open", "reopened", "firing", "unresolved", "belum beres", "masih firing", "kambuh"]) {
    assert.equal(parseStatusCommand(t), "reopen", t);
  }
});

test("a negation never reads as a close", () => {
  // the whole reason REOPEN is tested first — "belum selesai" contains "selesai"
  assert.equal(parseStatusCommand("belum selesai"), "reopen");
  assert.equal(parseStatusCommand("masih belum fixed"), "reopen");
  assert.equal(parseStatusCommand("not resolved"), "reopen");
});

test("ordinary thread talk is not a status change", () => {
  // these fall through to the agent — matching them would let small talk close an incident
  for (const t of ["ok thanks", "done, thanks!", "why did this fire?", "kenapa alert ini muncul", "cek dulu ya", "restart the pod"]) {
    assert.equal(parseStatusCommand(t), null, t);
  }
});

test("imperatives are requests, not status reports", () => {
  // "close"/"resolve" open far more requests than status reports — they must reach the agent
  assert.equal(parseStatusCommand("close the GitOps PR"), null);
  assert.equal(parseStatusCommand("resolve this by scaling up"), null);
});
