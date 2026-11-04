# devops-vm-agent

Restarts a systemd unit on a VM when — and only when — a human approved it in Slack and the unit is
in this VM's own allowlist. The VM pulls; nothing connects to it. Design:
`../docs/superpowers/specs/2026-11-04-node-ops-and-vm-agent-design.md` (Part B).

## Install (on the VM, as root)

```bash
install -m 0755 devops-vm-agent.py /usr/local/bin/devops-vm-agent.py
install -m 0600 devops-vm-agent.conf.example /etc/devops-vm-agent.conf   # then edit name, url, token, units
install -m 0644 devops-vm-agent.service /etc/systemd/system/devops-vm-agent.service
systemctl daemon-reload && systemctl enable --now devops-vm-agent
journalctl -u devops-vm-agent -f
```

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
