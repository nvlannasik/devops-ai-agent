# Node operations and the VM agent — design

Date: 2026-11-04. Two parts, built in this order: **A** cordon/uncordon/drain for Kubernetes nodes,
**B** restarting systemd services on VMs through a pull-based agent on each VM. Choices the user did
not state are marked **(my call)**.

## Intent

The agent fixes what it can reach. Today that is Kubernetes workloads. Two gaps:

- **A.** A failing Kubernetes node can be diagnosed (`k8s_describe_node`, node-exporter metrics) but not
  taken out of service. Cordon/uncordon/drain close that gap through the existing approval card.
- **B.** Some applications are not containerised: they run as systemd services on VMs. Those VMs already
  ship metrics, logs and traces to the central observability stack (the user, 2026-11-04), so the agent
  can already investigate them from telemetry. What it cannot do is act. Phase 1 of B is exactly one
  action: **restart a systemd service**, approved by a human.

The user asked for "SSH access" and, offered alternatives to a long-lived SSH key, chose a pull agent on
each VM: the VM fetches approved actions and runs only the ones its own allowlist permits. No key in the
cluster, no inbound port on the VM.

## Goals

- A: a proposal to cordon, uncordon or drain a node reaches a human as an approval card; Approve runs it on
  the node's cluster (local or remote, through the cluster router as today).
- B: an alert about a service on a registered VM is investigated as a VM incident (no Kubernetes tools, not
  "unlabelled", not capped to Low), and a proposal to restart that service becomes an approval card;
  Approve makes the VM run `systemctl restart <unit>` and the result appears in the Slack thread.
- B: the VM, not the agent, decides what may run on it.

## Non-goals

- Any VM action other than restarting a unit (no shell, no file edits, no package changes, no reboots).
- Free-form commands for diagnosis on the VM: diagnosis is the telemetry already shipped centrally.
- Installing/updating the VM agent from the central side (the VM's owner installs it).
- Node actions below Kubernetes (rebooting a node, restarting kubelet/containerd).

## Anti-goals

- An approved action running on the wrong host, twice, or late. A claimed action is never handed out again;
  a pending action older than the card window (15 min) expires and never runs.
- One VM able to see or claim another VM's actions. Host identity comes from its token, never from the body.
- A drain that takes a cluster's last schedulable node, a control-plane node, or a node whose pods a PDB
  protects (drain respects PDBs through the Eviction API and stops; it never deletes pods directly).

## Part A — cordon, uncordon, drain

- `devops-mcp-server`: three write tools behind `MCP_ENABLE_WRITE_TOOLS`, each with a dry-run:
  `k8s_cordon {node}`, `k8s_uncordon {node}`, `k8s_drain {node, timeoutSeconds?}`. Drain = cordon, then evict
  every pod that is not a DaemonSet pod or a mirror pod through the Eviction API (PDBs apply), report
  evicted / blocked / remaining. Refuse: a node with the control-plane role, the last schedulable node,
  a node that does not exist.
- Chart (`devops-ai-helm-charts`): `rbac.allowNodeOps` (default false) grants `patch` on `nodes` and
  `create` on `pods/eviction`; `_validate.tpl` requires write tools when it is on. New chart release; the
  gitops repo bumps the chart version and turns `allowNodeOps` on for dev and stg **(my call: both)**.
- Agent: register the three actions with the remediation flow (proposal parsing, the gates that apply to
  a node target, card text, verification = the node's `spec.unschedulable` and, for drain, no non-DaemonSet
  pods left after the check delay).

## Part B — the VM agent

### On each VM: `devops-vm-agent`

- One Python 3 file using only the standard library, run by a systemd unit **(my call: Python 3 ships with
  every mainstream server distribution; a Node runtime or a compiled binary would be a new install)**.
- Config `/etc/devops-vm-agent.conf` (owned by root, 0600): `name`, `url` (the central endpoint, `https://` or
  `http://` — the user wants both, chosen per VM), `ca_file` (optional, for an internal CA), `token`, `units`
  (the allowlist, e.g. `nginx.service orders.service`), `poll_seconds` (default 10). An `http://` URL logs a
  warning at start: the token and the actions travel in clear.
- Loop: heartbeat (name comes from the token; body carries `units`, `version`); claim the next action;
  if its unit is not in the local `units`, report `refused` without running anything; else run
  `systemctl restart <unit>` with a timeout, then report exit code, `systemctl is-active <unit>`, and the
  last 20 lines of `journalctl -u <unit>`.
- Logs every claim and result to journald.

### Central: endpoints, storage, auth

- Routes on the agent's existing express app (port 3000, where `/alert` lives) **(my call)**:
  `POST /vm/heartbeat`, `POST /vm/actions/claim`, `POST /vm/actions/:id/result`.
- Exposure is the user's to choose per environment (the user: "dynamic"): an HTTPS Ingress path `/vm/` on the
  agent's host (cert-manager TLS), and/or a plain-HTTP LAN Service (NodePort, as stg's MCP server). Each is a
  values switch; **(my call)** defaults: Ingress on, LAN Service off. With HTTP a stolen token can claim that
  VM's actions or fake its results, and a forged response can trigger a restart — bounded by the VM's own
  allowlist, which is why the allowlist lives on the VM.
- Auth: `Authorization: Bearer <token>`; tokens from `VM_AGENT_TOKENS="vm-web-01=<token>,…"` in a Secret
  the user creates; compared in constant time; the matching name IS the caller's identity.
- Postgres migration `018`: `vm_hosts (name pk, units text[], version, last_seen)` and
  `vm_actions (id, host, unit, action, status pending|claimed|succeeded|failed|refused|expired,
  remediation_id, created_at, claimed_at, finished_at, result jsonb)`. Claim is one atomic
  `UPDATE … WHERE status='pending' AND host=$1 AND created_at > now() - 15 min … RETURNING`.

### Agent: investigation and remediation

- A VM is "registered" when it heartbeated in the last 5 minutes.
- Alert binding: an alert whose host label names a registered VM is a VM incident. The label name is
  `VM_HOST_LABEL`, default `hostname` (the user, 2026-11-04). The run gets no Kubernetes tools, a note naming the
  VM and its allowed units, no cluster matcher injected into queries, and no unlabelled cap.
- Remediation: new action `vm_restart_service {host, unit}`. Proposed only for a registered VM and a unit in
  its heartbeat `units`; the card shows host, unit and the exact command. Approve inserts a `vm_actions` row;
  the result endpoint posts the outcome into the card's thread; verification after the usual delay reads the
  alert state and the VM's last report.

## Left to the builder

Exact tool/endpoint payload shapes, refusal wording (one language per reply), test layout, the VM agent's
retry/backoff, and how drain reports progress for slow evictions.
