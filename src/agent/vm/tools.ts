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

// The host snapshot as a virtual READ tool: what each devops-vm-agent sent with its last heartbeat
// (vm-agent snapshot(), migrations/019). No [WRITE] prefix, so the investigation loop may call it.
export const NODE_HOST_SNAPSHOT_TOOL = "node_host_snapshot";
/** Older than this, the snapshot is from before the node or its agent went quiet — say so. */
const STALE_SECONDS = 180;

const SNAPSHOT_DEFINITION: ToolDefinition = {
  name: NODE_HOST_SNAPSHOT_TOOL,
  description:
    "Host-level view of ONE node (or registered VM) from its devops-vm-agent, refreshed every minute: memory (total/available/anon/cache, swap), " +
    "the largest processes by RSS each with its systemd unit or `kubepods`, memory per systemd service (etcd, kubelet, containerd), all pods' " +
    "memory together, root disk, load. The ONLY tool that sees what runs OUTSIDE Kubernetes pods — call it when k8s_node_pods shows the node's " +
    "usage well above its pods' total working set, and on control-plane nodes, where etcd runs as a systemd service and is no pod. " +
    "Process names only, never command lines. Nodes of the agent's own cluster.",
  inputSchema: { type: "object", required: ["node"], properties: { node: { type: "string", description: "Node name, e.g. master3-vm" } } },
};

const mi = (bytes: unknown): string | undefined => (typeof bytes === "number" && Number.isFinite(bytes) ? `${Math.round(bytes / 1048576)}Mi` : undefined);

/** The stored snapshot in the shape the model reads: Mi strings instead of raw bytes, plus what is easy to misread. */
export function shapeSnapshot(node: string, snap: Record<string, unknown>, ageSeconds: number, version: string | null): Record<string, unknown> {
  const mem = (snap.memory ?? {}) as Record<string, number>;
  const disk = snap.rootDisk as { totalBytes?: number; availableBytes?: number } | undefined;
  const procs = Array.isArray(snap.processes) ? (snap.processes as Array<Record<string, unknown>>) : [];
  const units = Array.isArray(snap.units) ? (snap.units as Array<Record<string, unknown>>) : [];
  const out: Record<string, unknown> = { node, ageSeconds, agentVersion: version };
  if (ageSeconds > STALE_SECONDS) {
    out.stale = `this snapshot is ${ageSeconds}s old — the node or its agent stopped reporting; these numbers are from before that`;
  }
  if (snap.memory) {
    out.memory = {
      total: mi(mem.totalBytes),
      available: mi(mem.availableBytes),
      anonymous: mi(mem.anonBytes),
      pageCache: mi(mem.cachedBytes),
      swap: mem.swapTotalBytes ? `${mi(mem.swapTotalBytes)} (free ${mi(mem.swapFreeBytes)})` : "none",
    };
  }
  if (typeof snap.kubepodsMemoryBytes === "number") out.allPods = mi(snap.kubepodsMemoryBytes);
  if (units.length) out.systemdServices = units.map((u) => ({ unit: u.unit, memory: mi(u.memoryBytes) }));
  if (procs.length) {
    out.processes = procs.map((p) => ({ name: p.name, pid: p.pid, rss: mi(p.rssBytes), where: p.unit === "kubepods" ? "pod" : (p.unit ?? "unknown") }));
    out.processCount = snap.processCount;
  }
  if (Array.isArray(snap.load)) out.load = snap.load;
  if (typeof snap.uptimeSeconds === "number") out.uptimeHours = Math.round(snap.uptimeSeconds / 360) / 10;
  if (disk?.totalBytes) {
    out.rootDisk = { total: mi(disk.totalBytes), available: mi(disk.availableBytes), usedPercent: Math.round((1 - (disk.availableBytes ?? 0) / disk.totalBytes) * 100) };
  }
  out.notes = [
    "processes[].rss is resident memory of one process; a process whose `where` is a .service runs OUTSIDE Kubernetes and appears in no pod listing",
    "systemdServices[].memory and allPods are cgroup memory and INCLUDE page cache (containerd's often looks large from cached image layers); anonymous is what cannot be reclaimed",
    "memory.available is what the kernel can still give; with swap `none`, low available means the kubelet's eviction threshold is close",
  ];
  return out;
}

export function withVmTools(inner: McpTools, store: Pick<VmStore, "registered" | "enqueue" | "snapshot">): McpTools {
  return {
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    ping: () => inner.ping(),
    getTools: () => [...inner.getTools(), DEFINITION, SNAPSHOT_DEFINITION],
    async callTool(name, input) {
      if (name === NODE_HOST_SNAPSHOT_TOOL) {
        const node = String(input.node ?? input.host ?? "").trim().toLowerCase();
        if (!node) return "Error: `node` is required — the node name, e.g. master3-vm.";
        const got = await store.snapshot(node);
        if (!got) {
          const alive = await store.registered(node);
          return alive
            ? `Error: \`${node}\` runs a devops-vm-agent too old to send host snapshots (it needs version 3) — nothing is known about its processes.`
            : `Error: no devops-vm-agent reports as \`${node}\` — it is not installed on that node (or the name differs), so nothing outside its pods is visible.`;
        }
        return JSON.stringify(shapeSnapshot(node, got.snapshot, got.ageSeconds, got.version));
      }
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
