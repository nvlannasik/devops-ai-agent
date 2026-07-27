import { test } from "node:test";
import assert from "node:assert/strict";
import { commonLabels, groupIdentity, buildGroupAlertText, type AlertItem } from "./index.js";

const alert = (labels: Record<string, string>, extra: Partial<AlertItem> = {}): AlertItem => ({
  status: "firing",
  labels,
  ...extra,
});

test("commonLabels keeps only labels shared by every alert", () => {
  const alerts = [
    alert({ alertname: "KubePodCrashLooping", namespace: "prod", severity: "critical", pod: "web-a" }),
    alert({ alertname: "KubePodCrashLooping", namespace: "prod", severity: "critical", pod: "web-b" }),
    alert({ alertname: "KubePodCrashLooping", namespace: "prod", severity: "critical", pod: "web-c" }),
  ];
  assert.deepEqual(commonLabels(alerts), {
    alertname: "KubePodCrashLooping",
    namespace: "prod",
    severity: "critical",
  });
});

test("commonLabels of a single alert is all its labels (backward-compatible key)", () => {
  const one = alert({ alertname: "X", namespace: "prod", pod: "web-a" });
  assert.deepEqual(commonLabels([one]), { alertname: "X", namespace: "prod", pod: "web-a" });
});

test("groupIdentity prefers payload.commonLabels, then groupLabels, then computed, never empty", () => {
  const alerts = [alert({ alertname: "X", namespace: "prod", pod: "a" }), alert({ alertname: "X", namespace: "prod", pod: "b" })];
  // authoritative common labels win
  assert.deepEqual(groupIdentity({ commonLabels: { alertname: "X", namespace: "prod" } }, alerts), {
    alertname: "X",
    namespace: "prod",
  });
  // empty commonLabels falls through to groupLabels
  assert.deepEqual(groupIdentity({ commonLabels: {}, groupLabels: { alertname: "X" } }, alerts), { alertname: "X" });
  // nothing from the payload → computed intersection (pod drops out)
  assert.deepEqual(groupIdentity({}, alerts), { alertname: "X", namespace: "prod" });
  // never returns an empty object when there is an alert (would collide groups in Redis)
  assert.deepEqual(groupIdentity({}, [alert({ alertname: "Solo" })]), { alertname: "Solo" });
});

test("buildGroupAlertText renders a single alert with a Pod line", () => {
  const text = buildGroupAlertText(
    { alertname: "KubePodCrashLooping", namespace: "prod", severity: "critical" },
    [alert({ alertname: "KubePodCrashLooping", namespace: "prod", severity: "critical", pod: "web-a" }, { annotations: { summary: "pod is crashing" }, startsAt: "2026-07-27T10:00:00Z" })]
  );
  assert.match(text, /KubePodCrashLooping/);
  assert.match(text, /\*Pod:\* `web-a`/);
  assert.doesNotMatch(text, /Affected pods/);
  assert.doesNotMatch(text, /— \d+ alerts/); // no count suffix for a single alert
});

test("buildGroupAlertText lists affected pods and a count for a group", () => {
  const alerts = ["a", "b", "c"].map((p) =>
    alert({ alertname: "KubePodCrashLooping", namespace: "prod", severity: "critical", pod: `web-${p}` }, { startsAt: "2026-07-27T10:00:00Z" })
  );
  const text = buildGroupAlertText({ alertname: "KubePodCrashLooping", namespace: "prod", severity: "critical" }, alerts);
  assert.match(text, /— 3 alerts/);
  assert.match(text, /\*Affected pods \(3\):\*/);
  assert.match(text, /`web-a`.*`web-b`.*`web-c`/);
});

test("buildGroupAlertText tolerates a malformed startsAt (no throw, omits the line)", () => {
  // a NaN timestamp reaching new Date().toISOString() would throw and drop the alert
  const bad = alert({ alertname: "X", namespace: "prod", severity: "warning", pod: "p" }, { startsAt: "not-a-date" });
  let text = "";
  assert.doesNotThrow(() => {
    text = buildGroupAlertText({ alertname: "X", namespace: "prod", severity: "warning" }, [bad]);
  });
  assert.doesNotMatch(text, /Firing since/);
  assert.match(text, /KubePod|X/); // still renders the rest
});

test("buildGroupAlertText caps the pod list at 10 with a +N more suffix", () => {
  const alerts = Array.from({ length: 14 }, (_, i) =>
    alert({ alertname: "X", namespace: "prod", severity: "warning", pod: `p-${i}` })
  );
  const text = buildGroupAlertText({ alertname: "X", namespace: "prod", severity: "warning" }, alerts);
  assert.match(text, /\*Affected pods \(14\):\*/);
  assert.match(text, /\+4 more/);
});
