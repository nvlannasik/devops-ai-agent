import type { McpTools } from "../mcp/types.js";
import type { ToolDefinition } from "../llm/types.js";
import type { VmStore } from "./store.js";

// The VM restart as a virtual [WRITE] tool (spec 2026-11-04 Part B). The remediation flow only ever
// calls tools — a dry run before the card, the real call on Approve — so making the VM action one
// keeps every gate, card and approval path exactly as it is. The dry run checks what the VM itself
// reported; the real call only queues: the VM pulls the action and runs it against its own allowlist.
export const VM_RESTART_TOOL = "vm_restart_service";

const DEFINITION: ToolDefinition = {
  name: VM_RESTART_TOOL,
  description:
    "[WRITE] Restart one systemd unit on a registered VM (not Kubernetes). The VM's own agent pulls the approved action and runs " +
    "`systemctl restart <unit>` only if the unit is in its local allowlist. dry_run=true checks the VM is alive and allows the unit.",
  inputSchema: {
    type: "object",
    required: ["host", "unit"],
    properties: { host: { type: "string" }, unit: { type: "string" }, dry_run: { type: "boolean" }, remediation_id: { type: "number" } },
  },
};

export function withVmTools(inner: McpTools, store: Pick<VmStore, "registered" | "enqueue">): McpTools {
  return {
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    ping: () => inner.ping(),
    getTools: () => [...inner.getTools(), DEFINITION],
    async callTool(name, input) {
      if (name !== VM_RESTART_TOOL) return inner.callTool(name, input);
      const host = String(input.host ?? "");
      const unit = String(input.unit ?? "");
      const vm = await store.registered(host);
      if (!vm) return `Error: VM \`${host}\` is not registered — its agent has not heartbeated in the last 5 minutes, so nothing would pick the action up.`;
      if (!vm.units.includes(unit)) return `Error: \`${unit}\` is not in VM \`${host}\`'s allowlist (${vm.units.join(", ") || "empty"}) — the VM would refuse it.`;
      if (input.dry_run) return `validated — VM \`${host}\` is alive and allows \`${unit}\` (nothing was queued)`;
      const remediationId = typeof input.remediation_id === "number" ? input.remediation_id : null;
      await store.enqueue(host, unit, remediationId);
      return `queued for ${host} — the VM picks it up within its poll interval and reports back in this thread`;
    },
  };
}
