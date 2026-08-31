import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMentionMarker } from "./system.js";

const question = "cara tau penyebab spike nya";

test("the mode and scope rules ride on every mention, with or without an alert", () => {
  for (const alert of [null, { alertname: "HighLatency", namespace: "sample-apps" }]) {
    const marker = buildMentionMarker(question, alert);
    assert.match(marker, /conversation mode by default/);
    assert.match(marker, /Do NOT use the RCA incident format/);
    assert.match(marker, /Scope of Work/);
    assert.ok(marker.endsWith(`]\n${question}`), "the user's text must follow the marker verbatim");
  }
});

// The regression: a mention on an alert thread had nothing near it saying which namespace the
// incident was in, so a Loki line naming a host in `default` was the closest thing to a subject.
test("an alert thread restates its alertname and namespace next to the question", () => {
  const marker = buildMentionMarker(question, { alertname: "HighLatency", namespace: "sample-apps" });
  assert.match(marker, /HighLatency incident in namespace `sample-apps`/);
});

// It anchors, it does not lock: the cross-namespace hop that prompted this may have been right,
// because the logs named a Service the workload really calls. The rule asks for the evidence.
test("leaving the namespace is allowed against evidence, not forbidden", () => {
  const marker = buildMentionMarker(question, { alertname: "HighLatency", namespace: "sample-apps" });
  assert.match(marker, /allowed only when a tool result you have already read points there/);
  assert.doesNotMatch(marker, /never|forbidden|do not look/i);
});

test("an alert with no namespace label still names the alert, without an empty backtick pair", () => {
  const marker = buildMentionMarker(question, { alertname: "TargetDown", namespace: null });
  assert.match(marker, /TargetDown incident; keep that the subject/);
  assert.doesNotMatch(marker, /namespace ``/);
});

// A plain question in a fresh thread has nothing to anchor to — the clause must be absent, not
// present and empty.
test("a thread that was never an alert carries no alert clause", () => {
  const marker = buildMentionMarker(question, null);
  assert.doesNotMatch(marker, /incident;|keep that the subject/);
});
