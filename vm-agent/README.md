# devops-vm-agent

Restarts a systemd unit on a VM when — and only when — a human approved it in Slack and the unit is
in this VM's own allowlist. The VM pulls; nothing connects to it. Design:
`../docs/superpowers/specs/2026-11-04-node-ops-and-vm-agent-design.md` (Part B).

## Install (on the VM, as root)

```bash
# straight from the repo
curl -fsSL https://raw.githubusercontent.com/nvlannasik/devops-ai-agent/main/vm-agent/install.sh \
  | sudo VM_AGENT_TOKEN=<token> bash -s -- --units "nginx.service orders.service"

# or from a copy of this directory
sudo ./install.sh --token <token> --units "nginx.service orders.service"
```

`--name` defaults to `hostname`, `--url` to `https://agent.annasik.cloud`; `--poll` and `--ca-file`
set the rest. It writes `/etc/devops-vm-agent.conf` (0600), installs the script and unit, starts the
service and warns on a unit systemd does not know or an `http://` URL. Re-run it without a token to
upgrade the script and keep the config; `--uninstall` removes it all.

Needs Python 3 (standard library only). The token comes from the agent's `VM_AGENT_TOKENS`
(`<name>=<token>`); the name must equal this VM's `hostname` label in the central telemetry.

## What it does

Every `poll_seconds` it claims the next approved action for its name. A `restart` of a unit in
`units` runs `systemctl restart <unit>` (60 s timeout) and reports the exit code, `systemctl
is-active` and the last 20 journal lines, which the agent posts in the card's Slack thread.
Anything else is reported `refused` and nothing runs. A heartbeat every minute tells the agent
which units it may propose; a VM silent for 5 minutes gets no proposals.

The heartbeat also carries a read-only **host snapshot** (version 3+): `/proc/meminfo`, load and
uptime, the 15 largest processes by RSS (name from `/proc/<pid>/status`, never the command line,
plus the systemd unit or `kubepods` from `/proc/<pid>/cgroup`), `memory.current` of the 15 largest
`system.slice` services and of the kubepods cgroup (cgroup v2), and root disk usage. No subprocess
and no root needed for it; a section it cannot read is left out. The agent serves the latest one
as the `node_host_snapshot` tool. Every request carries `User-Agent: devops-vm-agent/<version>`:
Cloudflare refuses urllib's default with 403 (error 1010).

Since version 4 the config may name `cluster` and `node` (the Kubernetes cluster this host is a node of and its node name there); the agent groups hosts by them on its Hosts pages and joins them to Kubernetes. Leave both out on a machine outside any cluster: it is listed as standalone.

On the cluster's own Kubernetes nodes it is installed by the homelab-k8s playbook
(`inventory/homelab/devops-vm-agent.yml`), which pins a commit of this directory.

## Test

```bash
python3 -m unittest test_vm_agent
```
