import { test } from "node:test";
import assert from "node:assert/strict";
import { subjectOf, subjectMatch, podNodeMatch, hasNodeCandidate, nodeOfPod, CERT_FAMILY, type SubjectCandidate } from "./subject.js";

// Group labels as production stored them (incidents.group_labels), trimmed to what matters.
const CERT_A = { alertname: "CertificateRenewalOverdue", namespace: "headlamp", name: "headlamp-tls", issuer_kind: "ClusterIssuer", issuer_name: "letsencrypt-cluster-issuer", pod: "cert-manager-65dd558d9c-5xczw", node: "worker2-raspi", cluster: "dev" };
// A group spanning two certificates: name and issuer_name dropped out.
const CERT_B = { alertname: "CertificateExpiringSoon", namespace: "devops-tools", issuer_kind: "ClusterIssuer", pod: "cert-manager-65dd558d9c-5xczw", node: "worker2-raspi", cluster: "dev" };
const PRESSURE = { alertname: "KubernetesNodeMemoryPressure", node: "master3-vm", cluster: "dev", severity: "critical" };
const EVICTED = { alertname: "KubernetesPodNotHealthy", namespace: "monitoring", pod: "monitoring-prometheus-prometheus-node-exporter-4hq4p", cluster: "dev" };

const T = Date.parse("2026-11-14T15:00:00Z");
const cand = (labels: Record<string, string>, startedAt: number, threadTs = "1.1"): SubjectCandidate => ({
  threadTs,
  channel: "C1",
  alertname: labels.alertname!,
  namespace: labels.namespace ?? null,
  keys: subjectOf(labels).keys,
  startedAt,
});

test("subjectOf: a certificate alert is the cert-manager family — never the scraper's pod or node", () => {
  assert.deepEqual(subjectOf(CERT_A), { keys: [CERT_FAMILY], label: "headlamp/headlamp-tls" });
  assert.deepEqual(subjectOf(CERT_B), { keys: [CERT_FAMILY], label: "certificates in devops-tools" });
  assert.deepEqual(subjectOf(PRESSURE), { keys: ["node:master3-vm"], label: "master3-vm" });
  assert.deepEqual(subjectOf(EVICTED), { keys: [], pod: { namespace: "monitoring", name: EVICTED.pod }, label: `monitoring/${EVICTED.pod}` });
  assert.deepEqual(subjectOf({ alertname: "SampleAppHighLatency", namespace: "sample-apps" }).keys, []);
});

test("the 10 Nov storm: another certificate alert within 30 min joins the first; later or itself does not", () => {
  const first = cand(CERT_A, T);
  const b = { alertname: CERT_B.alertname, namespace: CERT_B.namespace, keys: subjectOf(CERT_B).keys };
  assert.equal(subjectMatch({ ...b, startsAt: T + 3 * 60_000 }, [first])!.via, "the same cert-manager storm");
  assert.equal(subjectMatch({ ...b, startsAt: T + 31 * 60_000 }, [first]), null, "outside the window");
  // its own group re-sent (same alertname, same namespace) is never a relation
  assert.equal(subjectMatch({ alertname: CERT_A.alertname, namespace: CERT_A.namespace, keys: [CERT_FAMILY], startsAt: T + 60_000 }, [first]), null);
});

test("another alert on the same node joins the node's open incident for hours, not for ever", () => {
  const pressure = cand(PRESSURE, T);
  const unreachable = { alertname: "KubernetesNodeUnreachable", namespace: null, keys: ["node:master3-vm"] };
  assert.equal(subjectMatch({ ...unreachable, startsAt: T + 5 * 3_600_000 }, [pressure])!.via, "same node `master3-vm`");
  assert.equal(subjectMatch({ ...unreachable, startsAt: T + 7 * 3_600_000 }, [pressure]), null);
  assert.equal(subjectMatch({ ...unreachable, keys: ["node:master2-vm"], startsAt: T + 60_000 }, [pressure]), null, "another node");
});

test("the 14 Nov storm: an evicted pod on the pressured node joins its incident", () => {
  const pressure = cand(PRESSURE, T);
  assert.equal(hasNodeCandidate([pressure], T + 3_600_000), true);
  assert.equal(hasNodeCandidate([cand(CERT_A, T)], T), false, "no node incident open: no pod lookup");
  const rel = podNodeMatch({ alertname: EVICTED.alertname, namespace: EVICTED.namespace, startsAt: T + 3_600_000 }, "master3-vm", [pressure]);
  assert.equal(rel!.via, "its pod runs on `master3-vm`, which has this KubernetesNodeMemoryPressure incident open");
  assert.equal(podNodeMatch({ alertname: EVICTED.alertname, namespace: EVICTED.namespace, startsAt: T }, "worker1-raspi", [pressure]), null);
});

test("nodeOfPod reads k8s_list_pods' rows; a miss or another shape is null", () => {
  const raw = JSON.stringify([{ name: EVICTED.pod, namespace: "monitoring", status: "Failed", ready: false, restarts: 0, node: "master3-vm" }]);
  assert.equal(nodeOfPod(raw, EVICTED.pod), "master3-vm");
  assert.equal(nodeOfPod(raw, "other"), null);
  assert.equal(nodeOfPod(JSON.stringify({ pods: [], noPodsMatched: true }), EVICTED.pod), null);
  assert.equal(nodeOfPod("Error: forbidden", EVICTED.pod), null);
});
