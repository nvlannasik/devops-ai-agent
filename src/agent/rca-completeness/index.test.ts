import { test } from "node:test";
import assert from "node:assert/strict";
import { rcaGaps, rcaGapNotice } from "./index.js";

const FULL =
  "*🔴 Severity:* `Critical`\n\n" +
  "*⚡ TL;DR*\n`shop/api` is down.\n\n" +
  "*🔧 Recommended Actions*\n1. *Immediate:* set `api` memory limit to `256Mi`\n\n" +
  "*📍 Root Cause*\n1. *Symptom:* OOMKilled at `128Mi` — _k8s_describe_pod_ `shop/api-7d9f`\n\n" +
  "*📊 Evidence*\n• *Fact:* restarts=5 — _k8s_list_pods_\n\n" +
  "*📈 Confidence:* `High` — three sources agree";

test("a complete RCA has no gaps", () => {
  assert.deepEqual(rcaGaps(FULL), []);
});

// The reported answer: it began at Root Cause, which is why the card said "Unknown Severity
// Incident" and why Postgres stored confidence = unknown for the same incident.
test("the answer that began at Root Cause is missing all three", () => {
  const partial =
    "*📍 Root Cause*\n1. *Symptom:* the image pull failed — _k8s_describe_pod_ `oauth2-proxy/p-8d4l7`\n\n" +
    "*📊 Evidence*\n• *Fact:* TLS handshake timeout to quay.io — _k8s_list_events_";
  assert.deepEqual(rcaGaps(partial), ["Severity", "Recommended Actions", "Confidence"]);
});

test("each required section is detected on its own", () => {
  assert.deepEqual(rcaGaps(FULL.replace("*🔴 Severity:* `Critical`\n\n", "")), ["Severity"]);
  assert.deepEqual(rcaGaps(FULL.replace(/\*📈 Confidence:\*[^\n]*/, "")), ["Confidence"]);
  assert.deepEqual(
    rcaGaps(FULL.replace("*🔧 Recommended Actions*\n1. *Immediate:* set `api` memory limit to `256Mi`\n\n", "")),
    ["Recommended Actions"],
  );
});

// A heading with nothing under it is the same problem as no heading: the remediation step reads
// the Immediate line, and an empty section has none.
test("a section heading with an empty body counts as missing", () => {
  const empty = FULL.replace("1. *Immediate:* set `api` memory limit to `256Mi`", "");
  assert.deepEqual(rcaGaps(empty), ["Recommended Actions"]);
});

// The model writes the heading with markdown's hard line break often enough that extractSection
// carries `[ \t]*` for it — a gate that missed those would nudge complete answers.
test("a trailing-space heading is still a present section", () => {
  assert.deepEqual(rcaGaps(FULL.replace("*🔧 Recommended Actions*\n", "*🔧 Recommended Actions*  \n")), []);
});

test("the notice names what is missing, what it was for, and that the whole answer must come back", () => {
  const notice = rcaGapNotice(["Severity", "Confidence"]);
  assert.match(notice, /Severity — the card header/);
  assert.match(notice, /Confidence — the on-call notification/);
  assert.doesNotMatch(notice, /Recommended Actions/, "a section that was present must not be asked for");
  assert.match(notice, /not a request for more tool calls/);
  assert.match(notice, /replaces the previous one/);
  assert.match(notice, /do not invent a finding/i);
});
