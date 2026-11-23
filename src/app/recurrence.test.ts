import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertFlow } from "./alerts.js";
import { InFlightRegistry } from "../agent/inflight/index.js";
import { config } from "../config/index.js";
import { workloadOf, repeatKey } from "../agent/incidents/repeat.js";

// A recurrence (agent/incidents/repeat.ts) through investigateAlertInBackground on a fake `this`:
// the same alert on the same subject, resolved hours ago, is investigated from that root cause with
// half the iterations, and the stored incident points at the one it recurred from.

const viaAlerts = (fake: object) => Object.assign(Object.create(AlertFlow.prototype), fake, { host: fake });
const LABELS = { alertname: "KubernetesNodeMemoryPressure", node: "master3-vm", cluster: "dev", severity: "critical" };

const harness = (prior: unknown) => {
  const posted: any[] = [];
  const investigated: Array<{ issue: string; opts: any }> = [];
  const marked: Array<[number, number]> = [];
  const self: any = {
    unstored: new Map(),
    inflight: new InFlightRegistry(() => null),
    semaphore: { acquire: async () => {}, release: () => {} },
    agent: {
      recallIncidents: async () => "",
      recallRemediations: async () => "",
      collectChanges: async () => null,
      mcpTools: () => [],
      clusters: { local: "dev" },
      bindThreadCluster: async () => {},
      vmFor: async () => null,
      recentRepeat: async () => prior,
      investigate: async (_t: string, issue: string, opts: any) => (investigated.push({ issue, opts }), "Same cause as incident #77: etcd outside the pods."),
      recordGate: () => {},
      markRcaSent: async () => {},
      storeIncident: async () => 120,
      markRepeat: async (id: number, of: number) => void marked.push([id, of]),
      clusterTool: async () => "[]",
    },
    app: { client: { chat: { postMessage: async (m: any) => (posted.push(m), {}), update: async () => ({}) } } },
    warnIfUngrounded: async () => {},
    notifyIfLowConfidence: async () => {},
    maybeProposeRemediation: async () => {},
  };
  const flow = viaAlerts(self) as AlertFlow & { closeIfResolvedEarly: () => Promise<void> };
  (flow as any).closeIfResolvedEarly = async () => {};
  const run = () => flow.investigateAlertInBackground("C1", "500.1", "*KubernetesNodeMemoryPressure* on master3-vm", LABELS, "", "critical", { alertAt: new Date(), subjects: [], serviceSubjects: [] });
  return { posted, investigated, marked, run };
};

test("a recurrence starts from the prior root cause, with the iteration cap, and is marked", async () => {
  const prior = { id: 77, createdAt: new Date(Date.now() - 5 * 3_600_000), resolvedAt: new Date(Date.now() - 3 * 3_600_000), rootCause: "etcd.service at 360Mi outside the pods; available 120Mi" };
  const h = harness(prior);
  await h.run();
  assert.equal(h.investigated.length, 1);
  assert.equal(h.investigated[0]!.opts.maxIterations, config.repeat.maxIterations);
  assert.match(h.investigated[0]!.issue, /\[RECURRENCE — this alert, on the same subject, was investigated 5 h ago \(incident #77\) and resolved 3 h ago/);
  assert.match(h.investigated[0]!.issue, /«etcd\.service at 360Mi outside the pods; available 120Mi»/);
  assert.match(h.posted[0].text, /♻️ \*Recurrence\* — the same alert on the same subject resolved 3 h ago \(incident #77\)/);
  assert.deepEqual(h.marked, [[120, 77]]);
});

test("no recurrence: the full investigation, unchanged", async () => {
  const h = harness(null);
  await h.run();
  assert.equal(h.investigated[0]!.opts.maxIterations, undefined);
  assert.doesNotMatch(h.investigated[0]!.issue, /RECURRENCE/);
  assert.deepEqual(h.marked, []);
});

test("workloadOf and repeatKey: replaced pods are one workload; nodes, services and namespaces keep apart", () => {
  assert.equal(workloadOf("monitoring-prometheus-prometheus-node-exporter-4hq4p"), "monitoring-prometheus-prometheus-node-exporter");
  assert.equal(workloadOf("checkout-gateway-64d79b5dcd-mskqq"), "checkout-gateway");
  assert.equal(workloadOf("loki-0"), "loki");
  assert.equal(workloadOf("kube-vip-master3-vm"), "kube-vip-master3-vm");
  assert.equal(workloadOf("kube-apiserver-master1-raspi"), "kube-apiserver-master1-raspi", "a static pod's node suffix is not a hash");
  assert.equal(workloadOf("speaker-rpjrn"), "speaker");
  assert.equal(repeatKey(LABELS), "node:master3-vm");
  assert.equal(repeatKey({ namespace: "monitoring", pod: "monitoring-prometheus-prometheus-node-exporter-mmlwv" }), "workload:monitoring/monitoring-prometheus-prometheus-node-exporter");
  assert.equal(repeatKey({ namespace: "sample-apps", pod: "x-1" }, ["orders-api", "checkout-gateway"]), "svc:sample-apps/checkout-gateway,orders-api");
  assert.equal(repeatKey({ alertname: "x" }), null);
});
