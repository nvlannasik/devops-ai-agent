import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNodesModel, loadNodes, toMi, type NodesInput, type NodesSource } from "./nodes.js";
import { nodesPage } from "./node-views.js";

const MiB = 1048576;
// master2-vm as the agent saw it on 2026-11-18, when it went MemoryPressure with ~400Mi free.
const SNAP = {
  memory: { totalBytes: 1968 * MiB, availableBytes: 404 * MiB, anonBytes: 1256 * MiB, cachedBytes: 428 * MiB, swapTotalBytes: 0, swapFreeBytes: 0 },
  load: [0.97, 1.18, 1.2],
  uptimeSeconds: 7 * 86400,
  processes: [
    { name: "kube-apiserver", pid: 900, rssBytes: 663 * MiB, unit: "kubepods" },
    { name: "etcd", pid: 812, rssBytes: 357 * MiB, unit: "etcd.service" },
  ],
  units: [{ unit: "etcd.service", memoryBytes: 364 * MiB }],
  kubepodsMemoryBytes: 1015 * MiB,
  rootDisk: { totalBytes: 24.4 * 1073741824, availableBytes: 15.7 * 1073741824 },
};
const NODES = [
  { name: "master2-vm", status: "True", unschedulable: false, taints: ["node-role.kubernetes.io/control-plane:NoSchedule"], pressure: ["MemoryPressure"], roles: ["control-plane"], allocatable: { memory: "1126100Ki" } },
  { name: "worker3-vm", status: "True", unschedulable: true, taints: [], pressure: [], roles: [], allocatable: { memory: "1126100Ki" } },
];
const PODS = (ws: string, head: string) => JSON.stringify({ podsTotal: 9, allocatable: { memory: "1100Mi" }, usage: { podsWorkingSet: ws, podsHeadroom: head } });

const source = (over: Partial<Record<string, string | Error>> = {}): NodesSource & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    hosts: async () => [
      { name: "master2-vm", units: [], version: "3", lastSeenSeconds: 20, snapshot: SNAP, snapshotAgeSeconds: 20 },
      { name: "worker3-vm", units: [], version: "2", lastSeenSeconds: 30, snapshot: null, snapshotAgeSeconds: null },
    ],
    actions: async () => [{ id: 4, host: "vm-a", unit: "nginx.service", action: "restart", status: "succeeded", createdAt: new Date("2026-11-18T10:00:00Z"), finishedAt: null, exitCode: 0 }],
    tool: async (name, args) => {
      const key = name === "k8s_get_resource" ? `lease:${args.name}` : name === "k8s_node_pods" ? `pods:${args.name}` : name;
      asked.push(key);
      const v = over[key];
      if (v instanceof Error) throw v;
      if (v !== undefined) return v;
      if (key === "k8s_list_nodes") return JSON.stringify(NODES);
      if (key === "lease:kube-controller-manager") return JSON.stringify({ spec: { holderIdentity: "master2-vm_66b59630" } });
      if (key === "lease:plndr-cp-lock") return JSON.stringify({ spec: { holderIdentity: "master2-vm" } });
      if (key === "lease:kube-scheduler") return JSON.stringify({ spec: { holderIdentity: "master1-raspi_a8dd" } });
      if (key === "pods:master2-vm") return PODS("1006Mi", "94Mi");
      return PODS("384Mi", "716Mi");
    },
  };
};

test("toMi reads every quantity shape the two sources use", () => {
  assert.equal(toMi("1126100Ki"), 1100);
  assert.equal(toMi("700Mi"), 700);
  assert.equal(toMi("1.5Gi"), 1536);
  assert.equal(toMi(2 * MiB), 2);
  assert.equal(toMi("lots"), null);
  assert.equal(toMi(null), null);
});

test("loadNodes reads the nodes, each node's pods and the three leases, and names what failed", async () => {
  const src = source({ "lease:kube-scheduler": new Error("forbidden"), "pods:worker3-vm": "Error: prometheus down" });
  const input = await loadNodes(src);
  assert.deepEqual(src.asked.filter((a) => a.startsWith("pods:")).sort(), ["pods:master2-vm", "pods:worker3-vm"]);
  assert.equal(input.leases.get("kube-controller-manager"), "master2-vm_66b59630");
  assert.equal(input.leases.has("kube-scheduler"), false);
  assert.ok(input.unavailable.some((u) => /Lease kube-scheduler: forbidden/.test(u)));
  assert.ok(input.unavailable.some((u) => /k8s_node_pods worker3-vm: Error: prometheus down/.test(u)));
  assert.equal(input.nodePods.has("worker3-vm"), false);
});

test("a failed node listing still shows the hosts the agents report", async () => {
  const input = await loadNodes(source({ k8s_list_nodes: new Error("API down") }));
  assert.equal(input.nodes, null);
  const m = buildNodesModel(input);
  assert.deepEqual(m.cards.map((c) => c.name).sort(), ["master2-vm", "worker3-vm"]);
  assert.equal(m.cards.find((c) => c.name === "master2-vm")!.k8s, null);
});

test("the model joins host and Kubernetes by name: leases, pod headroom, flags worst first", async () => {
  const m = buildNodesModel(await loadNodes(source()));
  const [cp, w] = m.cards;
  assert.equal(cp!.name, "master2-vm"); // control planes first
  assert.deepEqual(cp!.holds, ["controller-manager leader", "API VIP (kube-vip)"]);
  assert.deepEqual(cp!.pods, { count: 9, workingSetMi: 1006, allocatableMi: 1100, headroomMi: 94, tone: "critical" });
  assert.equal(cp!.host!.availableMi, 404);
  assert.equal(cp!.host!.disk!.usedPct, 36);
  assert.deepEqual(cp!.host!.processes[1], { name: "etcd", pid: 812, mi: 357, where: "etcd.service" });
  assert.equal(cp!.host!.processes[0]!.where, "pod");
  assert.deepEqual(cp!.flags.map((f) => f.text), ["MemoryPressure", "pods 94Mi from allocatable"]);
  assert.deepEqual(w!.flags.map((f) => f.text), ["cordoned", "agent v2 sends no snapshot"]);
  assert.deepEqual(m.summary, { nodes: 2, controlPlanes: 1, underPressure: 1, reporting: 1, tightest: { node: "master2-vm", headroomMi: 94 } });
});

test("an old snapshot is stale and says how old", () => {
  const input: NodesInput = {
    hosts: [{ name: "n1", units: [], version: "3", lastSeenSeconds: 900, snapshot: SNAP, snapshotAgeSeconds: 900 }],
    actions: [],
    nodes: null,
    nodePods: new Map(),
    leases: new Map(),
    unavailable: [],
  };
  const c = buildNodesModel(input).cards[0]!;
  assert.equal(c.host!.stale, true);
  assert.ok(c.flags.some((f) => f.text === "snapshot 900s old"));
  assert.equal(buildNodesModel(input).summary.reporting, 0);
});

test("the page shows each node, its leases, the pressure, the outside-pod services and the actions — escaped", async () => {
  const input = await loadNodes(source());
  input.hosts[0]!.snapshot = { ...SNAP, units: [{ unit: "<script>.service", memoryBytes: MiB }] };
  input.unavailable.push("k8s_node_pods x: <b>boom</b>");
  const html = nodesPage(buildNodesModel(input), new Date("2026-11-18T12:00:00Z"));
  for (const s of ["master2-vm", "worker3-vm", "controller-manager leader", "API VIP (kube-vip)", "MemoryPressure", "94Mi headroom", "etcd.service", "nginx.service", "Host actions", "Not everything could be read"]) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /1,?006 \/ 1,?100Mi/);
  assert.ok(!html.includes("<script>.service") && html.includes("&lt;script&gt;.service"));
  assert.ok(!html.includes("<b>boom</b>"));
  assert.match(html, /aria-current="page"[^>]*>|href="\/nodes"/);
});
