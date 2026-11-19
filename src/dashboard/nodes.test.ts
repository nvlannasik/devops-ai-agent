import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNodesModel, loadNodes, toMi, type HostRowLike, type NodesInput, type NodesSource } from "./nodes.js";
import { hostPage, hostsPage, nodeClusterPage } from "./node-views.js";

const MiB = 1048576;
// master2-vm as the agent saw it on 2026-11-18, when it went MemoryPressure with ~400Mi free.
const SNAP = {
  memory: { totalBytes: 1968 * MiB, availableBytes: 404 * MiB, anonBytes: 1256 * MiB, cachedBytes: 428 * MiB, swapTotalBytes: 0, swapFreeBytes: 0 },
  load: [0.97, 1.18, 1.2],
  uptimeSeconds: 7 * 86400,
  processes: [
    { name: "kube-apiserver", pid: 900, rssBytes: 663 * MiB, unit: "kubepods" },
    { name: "etcd", pid: 812, rssBytes: 357 * MiB, unit: "etcd.service" },
    { name: "kube-controller", pid: 950, rssBytes: 107 * MiB, unit: "kubepods" },
  ],
  units: [{ unit: "etcd.service", memoryBytes: 364 * MiB }, { unit: "containerd.service", memoryBytes: 120 * MiB }, { unit: "kubelet.service", memoryBytes: 80 * MiB }],
  kubepodsMemoryBytes: 1015 * MiB,
  rootDisk: { totalBytes: 24.4 * 1073741824, availableBytes: 15.7 * 1073741824 },
};
const NODES = [
  { name: "master2-vm", status: "True", unschedulable: false, taints: ["node-role.kubernetes.io/control-plane:NoSchedule"], pressure: ["MemoryPressure"], roles: ["control-plane"], allocatable: { memory: "1126100Ki" } },
  { name: "worker3-vm", status: "True", unschedulable: true, taints: [], pressure: [], roles: [], allocatable: { memory: "1126100Ki" } },
];
const PODS = (ws: string) => JSON.stringify({ podsTotal: 9, allocatable: { memory: "1100Mi" }, usage: { podsWorkingSet: ws } });
const host = (over: Partial<HostRowLike> & { name: string }): HostRowLike => ({ units: [], version: "3", lastSeenSeconds: 20, snapshot: SNAP, snapshotAgeSeconds: 20, cluster: null, node: null, ...over });

const source = (o: { names?: string[]; hosts?: HostRowLike[]; fail?: Record<string, string | Error>; slow?: string } = {}): NodesSource & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    clusters: () => ({ names: o.names ?? ["dev"], local: "dev" }),
    hosts: async () => o.hosts ?? [host({ name: "master2-vm" }), host({ name: "worker3-vm", version: "2", snapshot: null, snapshotAgeSeconds: null })],
    actions: async () => [{ id: 4, host: "vm-web-01", unit: "nginx.service", action: "restart", status: "succeeded", createdAt: new Date("2026-11-18T10:00:00Z"), finishedAt: null, exitCode: 0 }],
    tool: async (cluster, name, args) => {
      const key = `${cluster}:${name === "k8s_get_resource" ? `lease:${args.name}` : name === "k8s_node_pods" ? `pods:${args.name}` : name}`;
      asked.push(key);
      if (o.slow === cluster) await new Promise((r) => setTimeout(r, 200));
      const v = o.fail?.[key];
      if (v instanceof Error) throw v;
      if (v !== undefined) return v;
      if (key.endsWith(":k8s_list_nodes")) return JSON.stringify(NODES);
      if (key.endsWith("lease:kube-controller-manager")) return JSON.stringify({ spec: { holderIdentity: "master2-vm_66b59630" } });
      if (key.endsWith("lease:plndr-cp-lock")) return JSON.stringify({ spec: { holderIdentity: "master2-vm" } });
      if (key.endsWith("lease:kube-scheduler")) return JSON.stringify({ spec: { holderIdentity: "master1-raspi_a8dd" } });
      return key.endsWith("pods:master2-vm") ? PODS("1006Mi") : PODS("384Mi");
    },
  };
};

test("toMi reads every quantity shape the two sources use", () => {
  assert.equal(toMi("1126100Ki"), 1100);
  assert.equal(toMi("700Mi"), 700);
  assert.equal(toMi("1.5Gi"), 1536);
  assert.equal(toMi(2 * MiB), 2);
  assert.equal(toMi("lots"), null);
});

test("each cluster is read with its own name, and a failed read is named, not thrown", async () => {
  const src = source({ fail: { "dev:lease:kube-scheduler": new Error("forbidden"), "dev:pods:worker3-vm": "Error: prometheus down" } });
  const input = await loadNodes(src);
  assert.ok(src.asked.every((k) => k.startsWith("dev:")));
  assert.ok(input.unavailable.some((u) => /dev: Lease kube-scheduler: forbidden/.test(u)));
  assert.ok(input.unavailable.some((u) => /dev: k8s_node_pods worker3-vm: Error: prometheus down/.test(u)));
});

test("a cluster that does not answer in time is unreachable, and the others still render", async () => {
  const input = await loadNodes(source({ names: ["dev", "stg"], slow: "stg" }), 50);
  const m = buildNodesModel(input);
  assert.deepEqual(m.clusters.map((g) => [g.name, g.reachable]), [["dev", true], ["stg", false]]);
  assert.match(m.clusters[1]!.note!, /did not answer within/);
  assert.deepEqual(m.summary.unreachable, ["stg"]);
  assert.equal(m.clusters[0]!.cards.length, 2);
});

test("hosts are placed by what they say, else by the cluster that lists them, else standalone", async () => {
  const hosts = [
    host({ name: "master2-vm" }), // pre-v4, listed by dev
    host({ name: "stg.worker1", cluster: "stg", node: "worker1", version: "4" }), // says stg
    host({ name: "vm-web-01", version: "4", units: ["nginx.service"] }), // v4, no cluster: standalone
    host({ name: "old-vm", version: "3" }), // pre-v4, listed nowhere, dev reachable: standalone
  ];
  const m = buildNodesModel(await loadNodes(source({ names: ["dev", "stg"], hosts, fail: { "stg:k8s_list_nodes": new Error("connection refused") } })));
  const dev = m.clusters.find((g) => g.name === "dev")!;
  const stg = m.clusters.find((g) => g.name === "stg")!;
  assert.deepEqual(dev.cards.map((c) => c.name).sort(), ["master2-vm", "worker3-vm"]);
  assert.deepEqual(stg.cards.map((c) => [c.id, c.name]), [["stg.worker1", "worker1"]]);
  assert.equal(stg.reachable, false);
  assert.deepEqual(m.standalone.map((c) => c.name).sort(), ["old-vm", "vm-web-01"]);
  assert.equal(m.standalone.find((c) => c.name === "vm-web-01")!.lastAction!.status, "succeeded");
});

test("while the local cluster cannot be read, an older agent's host stays in it rather than turning standalone", async () => {
  const m = buildNodesModel(await loadNodes(source({ hosts: [host({ name: "master2-vm" })], fail: { "dev:k8s_list_nodes": new Error("down") } })));
  assert.deepEqual(m.clusters[0]!.cards.map((c) => c.name), ["master2-vm"]);
  assert.equal(m.standalone.length, 0);
});

test("a host naming a cluster the agent cannot read gets a group of its own", async () => {
  const m = buildNodesModel(await loadNodes(source({ hosts: [host({ name: "prd.n1", cluster: "prd", node: "n1", version: "4" })] })));
  const prd = m.clusters.find((g) => g.name === "prd")!;
  assert.equal(prd.reachable, false);
  assert.match(prd.note!, /cluster registry/);
});

test("a control plane gets its memory budget, the leases it holds, and flags worst first", async () => {
  const m = buildNodesModel(await loadNodes(source()));
  const cp = m.clusters[0]!.cards.find((c) => c.name === "master2-vm")!;
  assert.deepEqual(cp.holds, ["controller-manager leader", "API VIP (kube-vip)"]);
  assert.deepEqual(m.clusters[0]!.holders, [
    { label: "controller-manager", node: "master2-vm" },
    { label: "scheduler", node: "master1-raspi" },
    { label: "API VIP", node: "master2-vm" },
  ]);
  assert.deepEqual(cp.flags.map((f) => f.text), ["MemoryPressure", "pods 94Mi from allocatable"]);
  const parts = Object.fromEntries(cp.budget!.parts.map((p) => [p.key, p.mi]));
  // apiserver 663 + controller 107 + other pods 236 = the pods' 1006; etcd 364; runtime 200; OS the rest of 1564 used
  assert.deepEqual(parts, { apiserver: 663, controller: 107, pods: 236, etcd: 364, runtime: 200, free: 404 });
  assert.equal(cp.budget!.allocatableMi, 1100);
  assert.equal(m.clusters[0]!.cards[0]!.name, "master2-vm"); // worst first
});

const view = { group: null, attention: false, q: "" };

test("the fleet page groups by cluster, lists standalone hosts with their allowlist, and escapes", async () => {
  const hosts = [host({ name: "master2-vm" }), host({ name: "vm-<b>", version: "4", units: ["nginx.service"] })];
  const input = await loadNodes(source({ names: ["dev", "stg"], hosts, fail: { "stg:k8s_list_nodes": new Error("down") } }));
  const html = hostsPage(buildNodesModel(input), view, new Date("2026-11-18T12:00:00Z"));
  for (const s of ["Hosts", "group-dev", "group-stg", "unreachable", "Standalone hosts", "nginx.service", "controller-manager <strong>master2-vm</strong>", "/nodes/c/dev", "Clusters unreachable"]) assert.ok(html.includes(s), s);
  assert.ok(!html.includes("vm-<b>") && html.includes("vm-&lt;b&gt;"));
});

test("the fleet filters: one group, only what needs a look, a search", async () => {
  const m = buildNodesModel(await loadNodes(source({ hosts: [host({ name: "master2-vm" }), host({ name: "vm-web-01", version: "4" })] })));
  const devOnly = hostsPage(m, { ...view, group: "dev" });
  assert.ok(devOnly.includes("group-dev") && !devOnly.includes("group-standalone"));
  const attention = hostsPage(m, { ...view, attention: true });
  // the Host actions panel links vm-web-01 too, so look at the rows only
  const row = (n: string) => `class="node-host">${n}<`;
  assert.ok(attention.includes(row("master2-vm")) && !attention.includes(row("vm-web-01")));
  const search = hostsPage(m, { ...view, q: "web" });
  assert.ok(search.includes(row("vm-web-01")) && !search.includes(row("master2-vm")));
});

test("the cluster page draws each control plane's budget; the host page shows one host; unknown is null", async () => {
  const m = buildNodesModel(await loadNodes(source({ hosts: [host({ name: "master2-vm" }), host({ name: "vm-web-01", version: "4" })] })));
  const c = nodeClusterPage(m, "dev")!;
  assert.match(c, /class="budget-bar" role="img" aria-label="master2-vm: kube-apiserver 663Mi/);
  assert.match(c, /budget-line" style="--at:/);
  assert.ok(c.includes('id="node-worker3-vm"'));
  assert.equal(nodeClusterPage(m, "nope"), null);
  const h = hostPage(m, "vm-web-01")!;
  assert.ok(h.includes("vm-web-01") && h.includes("Standalone hosts"));
  assert.equal(hostPage(m, "nope"), null);
});

test("an empty input renders, never throws", () => {
  const input: NodesInput = { hosts: [], actions: [], clusters: [], local: null, unavailable: [] };
  assert.match(hostsPage(buildNodesModel(input), view), /No hosts/);
});

test("each row carries a decorative kind glyph, and VIP/leader glyphs sit beside their words", async () => {
  const hosts = [host({ name: "master2-vm" }), host({ name: "vm-web-01", version: "4" })];
  const html = hostsPage(buildNodesModel(await loadNodes(source({ hosts }))), view);
  assert.match(html, /<span class="host-kind" data-kind="cp"><svg class="ico"[^>]*aria-hidden="true"/);
  assert.match(html, /<span class="host-kind" data-kind="vm">/);
  assert.match(html, /<span class="ico-vip"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/span>VIP/);
  assert.match(html, /<span class="ico-lead"><svg[\s\S]*?<\/svg><\/span>CM leader/);
  assert.match(html, /class="node-holders"><span><span class="ico-lead">/);
  assert.match(html, />standalone VM</);
});
