import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceParts, controlPlaneBalance, holderNode, readBalance, BALANCE_QUERIES } from "./balance.js";

const MI = 1048576;
// Read live 2026-11-24: the leases, and the API servers' watches and memory by instance.
const LEASE = (holder: string) => JSON.stringify({ spec: { holderIdentity: holder } });
const LEASES = [LEASE("master3-vm_39d065ed-97ba-480c-adad-237b6ba765df"), LEASE("master2-vm_63e1bfe1-c590-4a19-989a-892df3636173"), LEASE("master3-vm")];
const vec = (rows: Array<[Record<string, string>, number]>) => JSON.stringify({ resultType: "vector", result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) });
const WATCHES = vec([[{ instance: "10.10.10.3:6443" }, 188], [{ instance: "10.10.10.2:6443" }, 238], [{ instance: "10.10.10.4:6443" }, 328]]);
const RSS = vec([[{ instance: "10.10.10.3:6443" }, 525197312], [{ instance: "10.10.10.2:6443" }, 571179008], [{ instance: "10.10.10.4:6443" }, 581238784]]);
const KUBELET = vec([
  [{ node: "master1-raspi", node_ip: "10.10.10.2" }, 1],
  [{ node: "master2-vm", node_ip: "10.10.10.3" }, 1],
  [{ node: "master3-vm", node_ip: "10.10.10.4" }, 1],
  [{ node: "worker1-raspi", node_ip: "10.10.10.11" }, 1],
]);
const MEMORY = new Map([
  ["master1-raspi", { lowest: 405 * MI, total: 1839 * MI }],
  ["master2-vm", { lowest: 516 * MI, total: 1968 * MI }],
  ["master3-vm", { lowest: 300 * MI, total: 1967 * MI }],
]);
const NODES = ["master1-raspi", "master2-vm", "master3-vm", "worker1-raspi"];

test("holderNode: a leader identity is the node plus a random suffix, or the node itself", () => {
  assert.equal(holderNode("master3-vm_39d065ed-97ba-480c-adad-237b6ba765df", NODES), "master3-vm");
  assert.equal(holderNode("master3-vm", NODES), "master3-vm");
  assert.equal(holderNode("unknown-host_abc", NODES), "unknown-host");
});

test("2026-11-24: master3-vm holds two leader roles, the most watches and the least memory — all three said", () => {
  const r = controlPlaneBalance(balanceParts(LEASES, WATCHES, RSS, KUBELET, NODES, MEMORY))!;
  assert.deepEqual(r.rows.map((x) => [x.node, x.roles, x.watches]), [
    ["master1-raspi", [], 238],
    ["master2-vm", ["scheduler"], 188],
    ["master3-vm", ["controller-manager", "API VIP (kube-vip)"], 328],
  ]);
  assert.equal(r.rows[2]!.apiserverMemory, "554Mi");
  assert.equal(r.rows[2]!.lowest24h, "300Mi");
  assert.match(r.findings[0]!, /`master3-vm` holds 2 of 3 leader roles \(controller-manager, API VIP \(kube-vip\)\) — the API VIP alone sends it every request from outside the cluster/);
  assert.match(r.findings[1]!, /`master3-vm` serves 328 long-running API requests \(watches\) against 188 on `master2-vm`/);
  assert.match(r.findings[2]!, /⚠️ and `master3-vm` has the least memory of the control planes \(300Mi\) — expect MemoryPressure there first\. Leader roles move only when a control-plane component restarts, which is not a fix to make/);
  assert.deepEqual(r.unread, []);
});

test("spread evenly: rows, no findings; under two control planes: nothing to compare", () => {
  const even = vec([[{ instance: "10.10.10.2:6443" }, 200], [{ instance: "10.10.10.3:6443" }, 210], [{ instance: "10.10.10.4:6443" }, 220]]);
  const r = controlPlaneBalance(balanceParts([LEASE("master1-raspi_x"), LEASE("master2-vm_y"), LEASE("master3-vm")], even, RSS, KUBELET, NODES, MEMORY))!;
  assert.deepEqual(r.findings, []);
  assert.equal(controlPlaneBalance(balanceParts([LEASE("m1"), null, null], null, null, null, ["m1"], new Map())), null);
});

test("what could not be read is named, never shown as balanced", () => {
  const r = controlPlaneBalance(balanceParts([LEASES[0]!, "Error: forbidden", null], WATCHES, null, KUBELET, NODES, MEMORY))!;
  assert.deepEqual(r.unread, ["lease kube-scheduler", "lease plndr-cp-lock", "API server memory (prometheus)"]);
});

test("readBalance asks the leases and the three queries, and survives every source failing", async () => {
  const asked: Array<[string, Record<string, unknown>]> = [];
  const answers: Record<string, string> = { [BALANCE_QUERIES.watches]: WATCHES, [BALANCE_QUERIES.rss]: RSS, [BALANCE_QUERIES.kubelet]: KUBELET };
  const r = await readBalance(async (name, args) => {
    asked.push([name, args]);
    if (name === "k8s_get_resource") return LEASES[["kube-controller-manager", "kube-scheduler", "plndr-cp-lock"].indexOf(String(args.name))]!;
    return answers[String(args.query)]!;
  }, MEMORY, NODES);
  assert.equal(asked.filter(([n]) => n === "k8s_get_resource").length, 3);
  assert.equal(r!.findings.length, 3);
  assert.equal(await readBalance(async () => { throw new Error("down"); }, new Map(), []), null);
});
