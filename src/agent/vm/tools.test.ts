import { test } from "node:test";
import assert from "node:assert/strict";
import { withVmTools, VM_RESTART_TOOL } from "./tools.js";
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
const store = (units: string[] | null) => {
  const queued: unknown[] = [];
  return { queued, registered: async () => (units ? { units } : null), enqueue: async (...a: unknown[]) => (queued.push(a), 41) };
};

test("the virtual tool is listed as [WRITE] beside the wrapped tools; others pass through", async () => {
  const t = withVmTools(inner as never, store(["nginx.service"]) as never);
  assert.deepEqual(t.getTools().map((x) => x.name), ["k8s_list_pods", VM_RESTART_TOOL]);
  assert.match(t.getTools()[1]!.description, /^\[WRITE\]/);
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
