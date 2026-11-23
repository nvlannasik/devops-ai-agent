import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertFlow } from "./alerts.js";
import { InFlightRegistry } from "../agent/inflight/index.js";

// Subject correlation (agent/correlation/subject.ts) on a fake `this`, like correlation.test.ts.
// The scenarios are the two production storms it exists for: cert-manager on 2026-11-10 and the
// master3-vm eviction loop on 2026-11-14.

const viaAlerts = (fake: object) => Object.assign(Object.create(AlertFlow.prototype), fake, { host: fake });
const NOW = Date.now();

const harness = (opts: { unstored?: Map<string, any>; open?: any[]; pods?: string } = {}) => {
  const posted: any[] = [];
  const stored: any[] = [];
  const asked: string[] = [];
  const toolCalls: any[] = [];
  const self: any = {
    unstored: opts.unstored ?? new Map(),
    inflight: new InFlightRegistry(() => null),
    agent: {
      openWithLabels: async () => opts.open ?? [],
      clusterTool: async (...a: any[]) => (toolCalls.push(a), opts.pods ?? "[]"),
      storeIncident: async (...a: any[]) => (stored.push(a), 9),
      investigate: async (_t: string, q: string) => (asked.push(q), "fits the root cause above"),
    },
    app: { client: { chat: { postMessage: async (m: any) => (posted.push(m), {}) } } },
    threadQueue: { run: (_t: string, fn: () => Promise<unknown>) => fn() },
    semaphore: { acquire: async () => {}, release: () => {} },
    inFlight: { track: (_m: unknown, p: Promise<unknown>) => p },
    conversationReply: async (r: string) => r,
    warnIfUngrounded: async () => {},
  };
  const flow = viaAlerts(self) as AlertFlow;
  const run = (labels: Record<string, string>) =>
    flow.correlateSubject("C-ALERTS", labels, [{ status: "firing", labels, annotations: {}, startsAt: new Date(NOW).toISOString() } as any], `*${labels.alertname}*`, "warning");
  return { posted, stored, asked, toolCalls, run };
};

test("the cert-manager storm: a second certificate alert joins the first, still in flight; the third asks no second question", async () => {
  const unstored = new Map([
    ["100.1", { key: "k", channel: "C-ALERTS", namespace: "headlamp", alertname: "CertificateRenewalOverdue", cluster: "dev", startedAt: NOW - 2 * 60_000, keys: ["cert-manager"] }],
  ]);
  const h = harness({ unstored });
  const merged = await h.run({ alertname: "CertificateExpiringSoon", namespace: "devops-tools", issuer_kind: "ClusterIssuer", cluster: "dev" });
  assert.equal(merged, true);
  assert.equal(h.posted[0].thread_ts, "100.1");
  assert.match(h.posted[0].text, /Related alert\* — CertificateExpiringSoon on `certificates in devops-tools` \(the same cert-manager storm\)/);
  assert.match(h.posted[0].text, /\*CertificateExpiringSoon\*/, "the first merge carries the alert text");
  assert.equal(h.stored[0][6].child, true);
  assert.equal(h.asked.length, 1);

  assert.equal(await h.run({ alertname: "CertificateNotReady", namespace: "sample-apps", issuer_kind: "ClusterIssuer", cluster: "dev" }), true);
  assert.equal(h.asked.length, 1, "one follow-up per parent per 30 min");
  assert.doesNotMatch(h.posted.at(-1).text, /\n\n/, "a merge without a follow-up is one line");
});

test("an evicted pod joins its node's open MemoryPressure incident — one pod listing to find the node", async () => {
  const h = harness({
    open: [{ threadTs: "200.1", channel: "C-ALERTS", alertname: "KubernetesNodeMemoryPressure", namespace: null, groupLabels: { alertname: "KubernetesNodeMemoryPressure", node: "master3-vm", cluster: "dev" }, startedAt: NOW - 60 * 60_000 }],
    pods: JSON.stringify([{ name: "speaker-rpjrn", namespace: "metallb-system", status: "Failed", ready: false, restarts: 0, node: "master3-vm" }]),
  });
  assert.equal(await h.run({ alertname: "KubernetesPodNotHealthy", namespace: "metallb-system", pod: "speaker-rpjrn", cluster: "dev" }), true);
  assert.deepEqual(h.toolCalls, [["dev", "k8s_list_pods", { namespace: "metallb-system" }]]);
  assert.match(h.posted[0].text, /its pod runs on `master3-vm`, which has this KubernetesNodeMemoryPressure incident open/);
  assert.equal(h.posted[0].thread_ts, "200.1");
});

test("a pod on another node, or no node incident open, takes the normal path — and no lookup without a node incident", async () => {
  const otherNode = harness({
    open: [{ threadTs: "200.1", channel: "C-ALERTS", alertname: "KubernetesNodeMemoryPressure", namespace: null, groupLabels: { alertname: "KubernetesNodeMemoryPressure", node: "master3-vm", cluster: "dev" }, startedAt: NOW - 60 * 60_000 }],
    pods: JSON.stringify([{ name: "speaker-x", namespace: "metallb-system", node: "worker1-raspi" }]),
  });
  assert.equal(await otherNode.run({ alertname: "KubernetesPodNotHealthy", namespace: "metallb-system", pod: "speaker-x", cluster: "dev" }), false);
  assert.equal(otherNode.posted.length, 0);

  const noNode = harness({
    open: [{ threadTs: "300.1", channel: "C-ALERTS", alertname: "CertificateNotReady", namespace: "headlamp", groupLabels: { alertname: "CertificateNotReady", namespace: "headlamp", issuer_kind: "ClusterIssuer" }, startedAt: NOW - 60_000 }],
  });
  assert.equal(await noNode.run({ alertname: "KubernetesPodNotHealthy", namespace: "metallb-system", pod: "speaker-x", cluster: "dev" }), false);
  assert.deepEqual(noNode.toolCalls, [], "no node incident open: no pod listing");

  const plain = harness();
  assert.equal(await plain.run({ alertname: "SampleAppHighLatency", namespace: "sample-apps", cluster: "dev" }), false);
});

test("another cluster's in-flight storm is never a candidate", async () => {
  const unstored = new Map([["100.1", { key: "k", channel: "C-ALERTS", namespace: "headlamp", alertname: "CertificateRenewalOverdue", cluster: "stg", startedAt: NOW - 60_000, keys: ["cert-manager"] }]]);
  const h = harness({ unstored });
  assert.equal(await h.run({ alertname: "CertificateExpiringSoon", namespace: "devops-tools", issuer_kind: "ClusterIssuer", cluster: "dev" }), false);
});
