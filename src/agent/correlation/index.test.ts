import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commonLabels,
  commonAnnotationsOf,
  distinctSubjects,
  groupIdentity,
  buildGroupAlertText,
  type AlertItem,
} from "./index.js";

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

// The real KubernetesContainerOomKiller payload that motivated this: the rule templates a raw
// value and a Go map onto the description, and the container — the field that matters most for
// an OOMKill — was reachable only by reading that map or the prose.
const oomLabels = {
  alertname: "KubernetesContainerOomKiller",
  cluster_name: "kubernetes-cluster-dev",
  container: "frr",
  instance: "kube-state-metrics.kube-system.svc.cluster.local:8080",
  job: "kube-state-metrics",
  namespace: "metallb-system",
  pod: "metallb-frr-k8s-tzllj",
  severity: "warning",
  uid: "53f79bfc-74e0-499f-8086-3240f8061926",
};
const oomAlert = alert(oomLabels, {
  startsAt: "2026-07-28T23:48:28.872Z",
  annotations: {
    summary: "Kubernetes Container oom killer (instance kube-state-metrics.kube-system.svc.cluster.local:8080)",
    description:
      "Container frr in pod metallb-system/metallb-frr-k8s-tzllj has been OOMKilled 2 times in the last 10 minutes.\n" +
      "  VALUE = 2\n" +
      "  LABELS = map[cluster_name:kubernetes-cluster-dev container:frr instance:kube-state-metrics.kube-system.svc.cluster.local:8080 job:kube-state-metrics namespace:metallb-system pod:metallb-frr-k8s-tzllj uid:53f79bfc-74e0-499f-8086-3240f8061926]",
  },
});

test("buildGroupAlertText strips the templated VALUE/LABELS tail from the description", () => {
  const text = buildGroupAlertText(oomLabels, [oomAlert]);
  assert.doesNotMatch(text, /VALUE =/);
  assert.doesNotMatch(text, /map\[/);
  // the sentence before the tail survives intact
  assert.match(text, /\*Description:\* Container frr in pod metallb-system\/metallb-frr-k8s-tzllj has been OOMKilled 2 times in the last 10 minutes\.$/m);
});

test("buildGroupAlertText promotes container to its own field", () => {
  assert.match(buildGroupAlertText(oomLabels, [oomAlert]), /\*Container:\* `frr`/);
});

test("buildGroupAlertText renders leftover labels sorted, without the ones already shown", () => {
  const text = buildGroupAlertText(oomLabels, [oomAlert]);
  const line = text.split("\n").find((l) => l.startsWith("*Labels:*"));
  assert.equal(
    line,
    "*Labels:* `cluster_name=kubernetes-cluster-dev` " +
      "`instance=kube-state-metrics.kube-system.svc.cluster.local:8080` `job=kube-state-metrics`"
  );
  // uid is unqueryable and changes every restart; the rest already have their own field
  for (const dup of ["uid=", "pod=", "namespace=", "container=", "severity=", "alertname="]) {
    assert.ok(!line!.includes(dup), `${dup} should not be repeated on the Labels line`);
  }
});

test("buildGroupAlertText omits Container when the group spans more than one", () => {
  const two = [
    alert({ alertname: "X", namespace: "prod", severity: "warning", pod: "p-a", container: "frr" }),
    alert({ alertname: "X", namespace: "prod", severity: "warning", pod: "p-b", container: "speaker" }),
  ];
  const text = buildGroupAlertText({ alertname: "X", namespace: "prod", severity: "warning" }, two);
  assert.doesNotMatch(text, /\*Container:\*/);
  assert.match(text, /\*Affected pods \(2\):\*/);
});

test("buildGroupAlertText omits the Labels line when nothing is left over", () => {
  const bare = alert({ alertname: "X", namespace: "prod", severity: "warning", pod: "p" });
  const text = buildGroupAlertText({ alertname: "X", namespace: "prod", severity: "warning" }, [bare]);
  assert.doesNotMatch(text, /\*Labels:\*/);
});

// ---- A group that spans more than one subject ----
//
// The production card: one rule, 4 alerts, 2 services, 2 pods. It rendered as
// "Summary: ... (service checkout-gateway)" and "Affected pods (4)" — one member's description
// presented as the group's, and the alert count printed as a pod count. This text is not
// decoration: app/index.ts posts it to Slack AND feeds it to investigate().
const errorRate = (service: string, pod: string, status: string): AlertItem => ({
  status: "firing",
  labels: { alertname: "HighErrorRate", severity: "critical", namespace: "sample-apps", service, pod, status },
  annotations: {
    summary: `High error rate detected (service ${service})`,
    description: `The error rate for service ${service} has exceeded 5% in the last 5 minutes.`,
  },
});

const fourAlerts = [
  errorRate("checkout-gateway", "checkout-gateway-6b747db7c9-zwdcv", "504"),
  errorRate("checkout-gateway", "checkout-gateway-6b747db7c9-zwdcv", "503"),
  errorRate("storefront", "storefront-64896f9bd4-8dxxr", "504"),
  errorRate("storefront", "storefront-64896f9bd4-8dxxr", "503"),
];
const groupLabels = { alertname: "HighErrorRate", severity: "critical", namespace: "sample-apps" };

test("a rule that templates its subject leaves no common annotation", () => {
  assert.deepEqual(commonAnnotationsOf(fourAlerts), {});
  // and a single alert's own annotations ARE the intersection, so n === 1 is unchanged
  assert.deepEqual(commonAnnotationsOf([fourAlerts[0]]), fourAlerts[0].annotations);
});

test("a description that speaks for one member is labelled as such, not as the group's", () => {
  const text = buildGroupAlertText(groupLabels, fourAlerts, {});
  assert.match(text, /\*Summary \(1 of 4\):\*/);
  assert.match(text, /\*Description \(1 of 4\):\*/);
});

test("a group that does agree keeps the plain label", () => {
  const shared = [errorRate("checkout-gateway", "pod-a", "504"), errorRate("checkout-gateway", "pod-b", "503")];
  const text = buildGroupAlertText(groupLabels, shared, {});
  assert.match(text, /\*Summary:\*/);
  assert.doesNotMatch(text, /1 of 2/);
});

test("the services the group really spans are named", () => {
  assert.deepEqual(distinctSubjects(fourAlerts), { key: "service", values: ["checkout-gateway", "storefront"] });
  assert.match(buildGroupAlertText(groupLabels, fourAlerts, {}), /\*Services \(2\):\* `checkout-gateway`, `storefront`/);
});

// One subject needs no scope line — the summary already names it.
test("a single-subject group gets no services line", () => {
  const one = [errorRate("checkout-gateway", "pod-a", "504"), errorRate("checkout-gateway", "pod-b", "503")];
  assert.doesNotMatch(buildGroupAlertText(groupLabels, one, {}), /Services \(/);
});

// The count was the alert count. A rule firing per (pod, status) makes that twice the truth.
test("affected pods are distinct, and the count matches the list", () => {
  const text = buildGroupAlertText(groupLabels, fourAlerts, {});
  assert.match(text, /\*Affected pods \(2\):\* `checkout-gateway-6b747db7c9-zwdcv`, `storefront-64896f9bd4-8dxxr`/);
  assert.doesNotMatch(text, /Affected pods \(4\)/);
});

test("subject detection falls through the label vocabulary and ignores the scrape job", () => {
  const byApp = [
    alert({ alertname: "A", app: "web", job: "kubernetes-pods" }),
    alert({ alertname: "A", app: "api", job: "kubernetes-pods" }),
  ];
  assert.deepEqual(distinctSubjects(byApp), { key: "app", values: ["api", "web"] });
  assert.equal(distinctSubjects([alert({ alertname: "A", job: "kubernetes-pods" })]), null);
});
