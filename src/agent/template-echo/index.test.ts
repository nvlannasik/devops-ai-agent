import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTemplateEcho } from "./index.js";

// The reported message, verbatim apart from the pod hash. Reported as "labelling like this in
// Slack is very untidy", which is exactly what it is: the template's slots printed as labels with
// the content pushed in behind them.
const LIVE = `*📍 Root Cause*
1. [Symptom] Pod oauth2-proxy-8d7b65c6b-8d4l7 in oauth2-proxy is Pending with container oauth2-proxy in state Waiting: ImagePullBackOff — k8s_describe_pod
2. ← [why step 1 happened] The image pull failed due to a TLS handshake timeout — evidence in events.
4. ⛔ [what you cannot see from here, and what access would show it] Need targeted network visibility.`;

test("the echoed slots go and the findings stay", () => {
  const { text, dropped } = stripTemplateEcho(LIVE);
  assert.equal(dropped, 3);
  assert.doesNotMatch(text, /\[Symptom\]|\[why step|\[what you cannot see/i);
  assert.match(text, /1\. Pod oauth2-proxy-8d7b65c6b-8d4l7 in oauth2-proxy is Pending/);
  assert.match(text, /2\. ← The image pull failed due to a TLS handshake timeout/);
  assert.match(text, /4\. ⛔ Need targeted network visibility\./);
  assert.equal(text.split("\n").length, LIVE.split("\n").length, "no line is lost");
});

// The whole reason this can be a blunt string operation is that the vocabulary is ours. Everything
// the cluster wrote has to survive, and log lines are full of brackets.
test("brackets the cluster wrote are never touched", () => {
  for (const line of [
    "• *Fact:* the container logged `[ERROR] connection refused` — _k8s_get_pod_logs_",
    "2026-09-25T04:12:00Z [warn] pool exhausted",
    "the probe reads `spec.containers[0].livenessProbe`",
    "• *Fact:* `[FATAL] DATABASE_URL is not set` — _loki_query_range_",
  ]) {
    assert.deepEqual(stripTemplateEcho(line), { text: line, dropped: 0 }, line);
  }
});

test("an answer that filled every slot is returned unchanged", () => {
  const clean = "*📍 Root Cause*\n1. *Symptom:* `shop/api` is CrashLoopBackOff — _k8s_describe_pod_ `shop/api-7d9f`";
  assert.deepEqual(stripTemplateEcho(clean), { text: clean, dropped: 0 });
});

test("the other sections' slots are covered too, not just the chain", () => {
  const { text, dropped } = stripTemplateEcho(
    "• [Fact 1] the pod restarted 4 times — _k8s_list_pods_\n" +
      "• [Hypothesis] a node problem — ruled out, every other pod is Ready",
  );
  assert.equal(dropped, 2);
  assert.match(text, /• the pod restarted 4 times/);
  assert.match(text, /• a node problem — ruled out/);
});

// A slot sits where the content begins, so removing it strands the em dash that was meant to
// separate the finding from its source.
test("the separator the slot left behind goes with it", () => {
  const { text } = stripTemplateEcho("1. [Symptom] — _k8s_describe_pod_ `ns/pod`");
  assert.equal(text, "1. _k8s_describe_pod_ `ns/pod`");
});
