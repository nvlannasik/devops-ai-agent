import { test } from "node:test";
import assert from "node:assert/strict";
import { hostRoles, quorum, silenceMessage, recoveryMessage, duration, type WatchedHost } from "./silence.js";

// Snapshots in the shape vm-agent 3 sends: a Kubespray master runs etcd as a systemd unit and
// kube-apiserver as a static pod (a `kubepods` process).
const MASTER = { units: [{ unit: "etcd.service", memoryBytes: 1 }], processes: [{ name: "kube-apiserver", unit: "kubepods", rssBytes: 1 }] };
const APISERVER_ONLY = { units: [], processes: [{ name: "kube-apiserver", unit: "kubepods", rssBytes: 1 }] };
const WORKER = { units: [{ unit: "kubelet.service", memoryBytes: 1 }], processes: [{ name: "kubelet", unit: "kubelet.service", rssBytes: 1 }] };

const host = (name: string, snapshot: object, lastSeenSeconds: number, cluster: string | null = null): WatchedHost => ({ name, node: null, cluster, lastSeenSeconds, snapshot: snapshot as Record<string, unknown> });
const NOW = new Date("2026-11-20T21:35:00Z");
const SILENT = 300;

// 2026-11-21 04:29 WIB: the three VMs went quiet within seconds of each other.
const OUTAGE: WatchedHost[] = [
  host("master1-raspi", MASTER, 20),
  host("master2-vm", MASTER, 320),
  host("master3-vm", MASTER, 310),
  host("worker1-raspi", WORKER, 30),
  host("worker2-raspi", WORKER, 40),
  host("worker3-vm", WORKER, 305),
];
const lastSeen = (s: number) => new Date(NOW.getTime() - s * 1000);
const silentOf = (names: string[]) => OUTAGE.filter((h) => names.includes(h.name)).map((h) => ({ ...h, lastSeen: lastSeen(h.lastSeenSeconds) }));

test("hostRoles reads etcd and the API server out of the host's own snapshot", () => {
  assert.deepEqual(hostRoles(MASTER), { etcd: true, controlPlane: true });
  assert.deepEqual(hostRoles(APISERVER_ONLY), { etcd: false, controlPlane: true });
  assert.deepEqual(hostRoles(WORKER), { etcd: false, controlPlane: false });
  assert.deepEqual(hostRoles({ processes: [{ name: "etcd", unit: "kubepods" }] }), { etcd: true, controlPlane: true }, "etcd as a static pod");
  assert.deepEqual(hostRoles(null), { etcd: false, controlPlane: false });
});

test("quorum: majority of the members that report; none for fewer than two members", () => {
  assert.deepEqual(quorum(OUTAGE, SILENT), { members: 3, alive: ["master1-raspi"], silent: ["master2-vm", "master3-vm"], has: false });
  assert.equal(quorum([host("m1", MASTER, 1), host("m2", MASTER, 400), host("m3", MASTER, 2)], SILENT)!.has, true);
  assert.equal(quorum([host("m1", MASTER, 1), host("w1", WORKER, 1)], SILENT), null);
});

test("the outage: three hosts at once, etcd quorum lost, and what to suspect first", () => {
  const t = silenceMessage(silentOf(["master2-vm", "master3-vm", "worker3-vm"]), OUTAGE, SILENT, NOW);
  assert.match(t, /^🔌 \*3 hosts stopped reporting\* — `master2-vm`, `master3-vm`, `worker3-vm`, last heard <!date\^\d+\^/);
  assert.match(t, /⛔ \*etcd has lost quorum\*: 1 of 3 members reporting \(`master1-raspi`\)\. The Kubernetes API cannot answer until one of `master2-vm`, `master3-vm` is back/);
  assert.match(t, /Control plane among them: `master2-vm`, `master3-vm`/);
  assert.match(t, /went quiet within 15 s of each other — look at what they share \(a hypervisor, a switch, power\)/);
  assert.match(t, /post in this thread when each one reports again/);
});

test("one control plane down: quorum held, and how close the API is to going with it", () => {
  const all = OUTAGE.map((h) => (h.name === "master3-vm" ? h : { ...h, lastSeenSeconds: 10 }));
  const t = silenceMessage([{ ...all.find((h) => h.name === "master3-vm")!, lastSeen: lastSeen(310) }], all, SILENT, NOW);
  assert.match(t, /^🔌 \*master3-vm stopped reporting\*/);
  assert.match(t, /⚠️ etcd still has quorum \(2 of 3 reporting\) — losing one more of `master1-raspi`, `master2-vm` takes the Kubernetes API down/);
  assert.doesNotMatch(t, /within .* of each other/, "one host has nothing to share");
});

test("every host silent at once points at the path to the agent, not at etcd", () => {
  const all = OUTAGE.map((h) => ({ ...h, lastSeenSeconds: 400 }));
  const t = silenceMessage(all.map((h) => ({ ...h, lastSeen: lastSeen(400) })), all, SILENT, NOW);
  assert.match(t, /\*Every\* known host is silent — more likely the hosts cannot reach the agent's `\/vm\/` endpoint/);
  assert.doesNotMatch(t, /quorum/);
});

test("a worker alone says nothing about etcd", () => {
  const all = OUTAGE.map((h) => (h.name === "worker3-vm" ? h : { ...h, lastSeenSeconds: 10 }));
  const t = silenceMessage([{ ...all.find((h) => h.name === "worker3-vm")!, lastSeen: lastSeen(305) }], all, SILENT, NOW);
  assert.doesNotMatch(t, /etcd|Control plane/);
});

test("recovery: how long it was gone, and the quorum once an etcd member is back", () => {
  const back = OUTAGE.map((h) => (h.name === "master2-vm" ? { ...h, lastSeenSeconds: 5 } : h));
  const since = new Date(NOW.getTime() - (66 * 3600 + 57 * 60) * 1000);
  const t = recoveryMessage({ name: "master2-vm", node: null, cluster: null, silentSince: since }, back, SILENT, NOW);
  assert.match(t, /^✅ `master2-vm` is reporting again after 66 h 57 min of silence\./);
  assert.match(t, /etcd has quorum again \(2 of 3 reporting\) — still silent: `master3-vm`\./);
  const worker = recoveryMessage({ name: "worker3-vm", node: null, cluster: null, silentSince: since }, back, SILENT, NOW);
  assert.doesNotMatch(worker, /etcd/);
});

test("duration reads like a person would say it", () => {
  assert.equal(duration(45), "45 s");
  assert.equal(duration(12 * 60), "12 min");
  assert.equal(duration(3 * 3600), "3 h");
  assert.equal(duration(66 * 3600 + 57 * 60), "66 h 57 min");
});
