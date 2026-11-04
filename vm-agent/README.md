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

## Test

```bash
python3 -m unittest test_vm_agent
```
