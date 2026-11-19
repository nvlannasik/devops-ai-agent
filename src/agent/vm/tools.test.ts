import { test } from "node:test";
import assert from "node:assert/strict";
import { withVmTools, pickHost, VM_RESTART_TOOL, NODE_HOST_SNAPSHOT_TOOL } from "./tools.js";
import type { SnapshotCandidate } from "./store.js";
import { parseProposal, PROPOSABLE_ACTIONS } from "../remediation/proposal.js";
import { NO_POD_TARGET } from "../remediation/remediator.js";

const inner = {
  calls: [] as string[],
  connect: async () => {},
  disconnect: async () => {},
  ping: async () => true,
  getTools: () => [{ name: "k8s_list_pods", description: "list", inputSchema: {} }],
  callTool: async (name: string) => (inner.calls.push(name), "inner"),
};
const store = (units: string[] | null, snap: { snapshot: Record<string, unknown>; ageSeconds: number; version: string | null } | null = null, cands?: SnapshotCandidate[]) => {
  const queued: unknown[] = [];
  const asked: string[] = [];
  return {
    queued,
    asked,
    registered: async () => (units ? { units } : null),
    enqueue: async (...a: unknown[]) => (queued.push(a), 41),
    snapshotCandidates: async (n: string): Promise<SnapshotCandidate[]> => {
      asked.push(n);
      if (cands) return cands;
      if (snap) return [{ name: n, cluster: null, node: null, snapshot: snap.snapshot, ageSeconds: snap.ageSeconds, version: snap.version }];
      return units ? [{ name: n, cluster: null, node: null, snapshot: null, ageSeconds: null, version: "2" }] : [];
    },
  };
};

test("the virtual tools are listed beside the wrapped tools — restart [WRITE], snapshot read-only; others pass through", async () => {
  const t = withVmTools(inner as never, store(["nginx.service"]) as never);
  assert.deepEqual(t.getTools().map((x) => x.name), ["k8s_list_pods", VM_RESTART_TOOL, NODE_HOST_SNAPSHOT_TOOL]);
  assert.match(t.getTools()[1]!.description, /^\[WRITE\]/);
  assert.doesNotMatch(t.getTools()[2]!.description, /^\[WRITE\]/);
  assert.equal(await t.callTool("k8s_list_pods", {}), "inner");
});

test("the dry run refuses a VM that stopped heartbeating and a unit it did not list", async () => {
  assert.match(await withVmTools(inner as never, store(null) as never).callTool(VM_RESTART_TOOL, { host: "vm-a", unit: "nginx.service", dry_run: true }), /^Error: .*vm-a.*not registered/);
  const s = store(["nginx.service"]);
  assert.match(await withVmTools(inner as never, s as never).callTool(VM_RESTART_TOOL, { host: "vm-a", unit: "sshd.service", dry_run: true }), /^Error: .*sshd\.service.*allowlist/);
  assert.match(await withVmTools(inner as never, s as never).callTool(VM_RESTART_TOOL, { host: "vm-a", unit: "nginx.service", dry_run: true }), /^validated/);
  assert.deepEqual(s.queued, []);
});

test("the real call enqueues once, with the remediation id", async () => {
  const s = store(["nginx.service"]);
  assert.match(await withVmTools(inner as never, s as never).callTool(VM_RESTART_TOOL, { host: "vm-a", unit: "nginx.service", remediation_id: 12 }), /queued for vm-a/);
  assert.deepEqual(s.queued, [["vm-a", "nginx.service", 12]]);
});

test("vm_restart_service parses to a proposal keyed on the host, with no pod verification", () => {
  const p = parseProposal('{"action":"vm_restart_service","host":"VM-Web-01","unit":"nginx.service","reason":"5xx"}')!;
  assert.deepEqual({ a: p.action, ns: p.namespace, n: p.name, tp: p.toolParams }, { a: VM_RESTART_TOOL, ns: "", n: "vm-web-01", tp: { host: "vm-web-01", unit: "nginx.service" } });
  assert.match(p.summary, /restart `nginx\.service` on VM `vm-web-01`/);
  assert.ok((PROPOSABLE_ACTIONS as readonly string[]).includes(VM_RESTART_TOOL));
  assert.ok(NO_POD_TARGET.has(VM_RESTART_TOOL));
});

// The shape a version-3 vm-agent sends (vm-agent snapshot()), numbers from master3-vm on 2026-11-17.
const MASTER3 = {
  memory: { totalBytes: 2062548992, availableBytes: 208666624, anonBytes: 1552089088, cachedBytes: 263860224, swapTotalBytes: 0, swapFreeBytes: 0 },
  load: [1.5, 1.4, 1.3],
  uptimeSeconds: 418000,
  processes: [
    { name: "kube-apiserver", pid: 900, rssBytes: 740294656, unit: "kubepods" },
    { name: "etcd", pid: 812, rssBytes: 344981504, unit: "etcd.service" },
  ],
  processCount: 160,
  units: [{ unit: "etcd.service", memoryBytes: 349495296 }, { unit: "containerd.service", memoryBytes: 113246208 }],
  kubepodsMemoryBytes: 1100000000,
  rootDisk: { totalBytes: 20000000000, availableBytes: 9000000000 },
};

test("node_host_snapshot: Mi strings, where each process runs, and the cache caveat", async () => {
  const s = store([], { snapshot: MASTER3, ageSeconds: 30, version: "3" });
  const out = JSON.parse(await withVmTools(inner as never, s as never).callTool(NODE_HOST_SNAPSHOT_TOOL, { node: "Master3-VM" }));
  assert.deepEqual(s.asked, ["master3-vm"]);
  assert.equal(inner.calls.includes(NODE_HOST_SNAPSHOT_TOOL), false);
  assert.deepEqual(out.memory, { total: "1967Mi", used: "1768Mi", available: "199Mi", anonymous: "1480Mi", pageCache: "252Mi", swap: "none" });
  assert.equal(out.systemdServicesTotal, "441Mi");
  assert.deepEqual(out.processes[1], { name: "etcd", pid: 812, rss: "329Mi", where: "etcd.service" });
  assert.equal(out.processes[0].where, "pod");
  assert.deepEqual(out.systemdServices[0], { unit: "etcd.service", memory: "333Mi" });
  assert.equal(out.allPods, "1049Mi");
  assert.equal(out.rootDisk.usedPercent, 55);
  assert.equal(out.stale, undefined);
  assert.ok(out.notes.some((n: string) => /page cache/.test(n)));
});

test("node_host_snapshot: an old snapshot says so; no agent and an old agent are told apart", async () => {
  const stale = JSON.parse(await withVmTools(inner as never, store([], { snapshot: MASTER3, ageSeconds: 900, version: "3" }) as never).callTool(NODE_HOST_SNAPSHOT_TOOL, { node: "master3-vm" }));
  assert.match(stale.stale, /900s old/);
  assert.match(await withVmTools(inner as never, store(null) as never).callTool(NODE_HOST_SNAPSHOT_TOOL, { node: "worker9" }), /^Error: no devops-vm-agent reports as `worker9`/);
  assert.match(await withVmTools(inner as never, store([]) as never).callTool(NODE_HOST_SNAPSHOT_TOOL, { node: "master3-vm" }), /^Error: .*too old .*version 3/);
  assert.match(await withVmTools(inner as never, store([]) as never).callTool(NODE_HOST_SNAPSHOT_TOOL, {}), /^Error: `node` is required/);
});

const cand = (name: string, cluster: string | null, node: string | null = null): SnapshotCandidate => ({ name, cluster, node, snapshot: { memory: {} }, ageSeconds: 10, version: "4" });

test("pickHost: a host naming its cluster must match; one naming none stands for the local cluster", () => {
  const both = [cand("worker1", "dev"), cand("stg.worker1", "stg", "worker1")];
  assert.equal((pickHost(both, "worker1", "stg", "dev") as SnapshotCandidate).name, "stg.worker1");
  assert.equal((pickHost(both, "worker1", "dev", "dev") as SnapshotCandidate).name, "worker1");
  assert.ok(Array.isArray(pickHost(both, "worker1", null, "dev")), "unbound and two hosts: ambiguous, never a guess");
  const legacy = [cand("master3-vm", null)];
  assert.equal((pickHost(legacy, "master3-vm", "dev", "dev") as SnapshotCandidate).name, "master3-vm");
  assert.equal(pickHost(legacy, "master3-vm", "stg", "dev"), null, "an unplaced host is not a stg node");
  assert.equal(pickHost([], "x", null, "dev"), null);
});

test("node_host_snapshot: ambiguous names ask for a cluster; the bound cluster is the default", async () => {
  const both = [cand("worker1", "dev"), cand("stg.worker1", "stg", "worker1")];
  const unbound = withVmTools(inner as never, store([], null, both) as never, () => ({ cluster: null, local: "dev" }));
  assert.match(await unbound.callTool(NODE_HOST_SNAPSHOT_TOOL, { node: "worker1" }), /several hosts — `worker1` \(dev\), `stg.worker1` \(stg\)\. Pass `cluster`/);
  const bound = withVmTools(inner as never, store([], null, both) as never, () => ({ cluster: "stg", local: "dev" }));
  assert.equal(JSON.parse(await bound.callTool(NODE_HOST_SNAPSHOT_TOOL, { node: "worker1" })).host, "stg.worker1");
  assert.equal(JSON.parse(await unbound.callTool(NODE_HOST_SNAPSHOT_TOOL, { node: "worker1", cluster: "dev" })).cluster, "dev");
});
