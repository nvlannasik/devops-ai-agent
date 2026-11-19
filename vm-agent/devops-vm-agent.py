#!/usr/bin/env python3
"""devops-vm-agent — pulls approved restarts from the devops agent and runs only its own allowlist.

Every heartbeat (once a minute) also carries a read-only snapshot of the host — memory, the
largest processes by RSS with their systemd unit, memory per systemd service, root disk — so the
agent can see what runs outside Kubernetes pods (etcd, kubelet, containerd). See snapshot().

Spec: devops-ai-agent/docs/superpowers/specs/2026-11-04-node-ops-and-vm-agent-design.md (Part B).
The VM opens every connection (no inbound port), proves who it is with its own bearer token, and
decides for itself what may run: an action whose unit is not in `units` below is reported
`refused` and nothing is executed. The only command it ever runs is `systemctl restart <unit>`
(plus `systemctl is-active` and `journalctl` to report the result). Python 3 standard library only.
"""
import configparser
import json
import logging
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

VERSION = "4"
log = logging.getLogger("devops-vm-agent")


def load_config(path):
    """Reads the [agent] section; a missing name/url/token exits — an agent that cannot say who it is must not run."""
    cp = configparser.ConfigParser()
    if not cp.read(path):
        sys.exit(f"cannot read {path}")
    a = cp["agent"] if cp.has_section("agent") else {}
    missing = [k for k in ("name", "url", "token") if not a.get(k)]
    if missing:
        sys.exit(f"{path}: missing {', '.join(missing)} in [agent]")
    ident = re.compile(r"^[a-z0-9][a-z0-9.-]{0,62}$")
    for key in ("cluster", "node"):
        if a.get(key) and not ident.match(a[key]):
            sys.exit(f"{path}: {key} must be lowercase letters, digits, . and - (got {a[key]!r})")
    return {
        "name": a["name"],
        # The Kubernetes cluster this host is a node of, and its node name there; both empty for a
        # host outside any cluster. The agent groups hosts by them and joins them to Kubernetes.
        "cluster": a.get("cluster") or None,
        "node": a.get("node") or None,
        "url": a["url"].rstrip("/"),
        "token": a["token"],
        "units": a.get("units", "").split(),
        "poll_seconds": int(a.get("poll_seconds", "10")),
        "ca_file": a.get("ca_file") or None,
    }


TOP_PROCESSES = 15
TOP_UNITS = 15


def _read(path):
    with open(path) as f:
        return f.read()


def _unit_of(cgroup_text):
    """The systemd unit a process belongs to, "kubepods" for anything in a pod, or None."""
    for line in cgroup_text.splitlines():
        path = line.split(":", 2)[-1]
        if "kubepods" in path:
            return "kubepods"
        for part in reversed(path.split("/")):
            if part.endswith((".service", ".scope")):
                return part
    return None


def snapshot(proc="/proc", cgroup="/sys/fs/cgroup"):
    """What this host is doing, sent with every heartbeat. Read-only, no subprocess, no root needed.

    Process NAMES only (/proc/<pid>/status Name, max 15 chars), never the command line: the
    API server's and etcd's arguments carry certificate paths and sometimes credentials. Every
    section is best-effort — a missing file leaves that section out, it never stops the heartbeat.
    """
    out = {}
    try:
        kb = {}
        for line in _read(f"{proc}/meminfo").splitlines():
            key, _, rest = line.partition(":")
            kb[key] = int(rest.split()[0])
        out["memory"] = {
            "totalBytes": kb["MemTotal"] * 1024,
            "availableBytes": kb["MemAvailable"] * 1024,
            "anonBytes": kb.get("AnonPages", 0) * 1024,
            "cachedBytes": kb.get("Cached", 0) * 1024,
            "swapTotalBytes": kb.get("SwapTotal", 0) * 1024,
            "swapFreeBytes": kb.get("SwapFree", 0) * 1024,
        }
    except (OSError, KeyError, ValueError, IndexError):
        pass
    try:
        out["load"] = [float(x) for x in _read(f"{proc}/loadavg").split()[:3]]
        out["uptimeSeconds"] = int(float(_read(f"{proc}/uptime").split()[0]))
    except (OSError, ValueError, IndexError):
        pass

    procs = []
    try:
        pids = [d for d in os.listdir(proc) if d.isdigit()]
    except OSError:
        pids = []
    for pid in pids:
        try:
            fields = dict(line.split(":", 1) for line in _read(f"{proc}/{pid}/status").splitlines() if ":" in line)
            if "VmRSS" not in fields:  # kernel threads have no user memory
                continue
            rss = int(fields["VmRSS"].split()[0]) * 1024
            unit = _unit_of(_read(f"{proc}/{pid}/cgroup"))
        except (OSError, ValueError, IndexError):
            continue  # gone between listdir and read, or unreadable
        procs.append({"name": fields.get("Name", "?").strip(), "pid": int(pid), "rssBytes": rss, "unit": unit})
    if procs:
        procs.sort(key=lambda p: p["rssBytes"], reverse=True)
        out["processes"] = procs[:TOP_PROCESSES]
        out["processCount"] = len(procs)

    # cgroup v2: memory.current per systemd service (includes its page cache, unlike RSS).
    units = []
    try:
        for name in os.listdir(f"{cgroup}/system.slice"):
            if name.endswith(".service"):
                try:
                    units.append({"unit": name, "memoryBytes": int(_read(f"{cgroup}/system.slice/{name}/memory.current"))})
                except (OSError, ValueError):
                    pass
    except OSError:
        pass
    if units:
        units.sort(key=lambda u: u["memoryBytes"], reverse=True)
        out["units"] = units[:TOP_UNITS]
    for slice_ in ("kubepods.slice", "kubepods"):
        try:
            out["kubepodsMemoryBytes"] = int(_read(f"{cgroup}/{slice_}/memory.current"))
            break
        except (OSError, ValueError):
            pass
    try:
        st = os.statvfs("/")
        out["rootDisk"] = {"totalBytes": st.f_blocks * st.f_frsize, "availableBytes": st.f_bavail * st.f_frsize}
    except OSError:
        pass
    return out


class Agent:
    def __init__(self, cfg, runner=subprocess.run, snap=snapshot):
        self.cfg = cfg
        self.run = runner
        self.snap = snap
        self.ssl = ssl.create_default_context(cafile=cfg["ca_file"]) if cfg["ca_file"] else None
        if cfg["url"].startswith("http://"):
            log.warning("url is http:// — the token and the actions travel in clear; use https:// outside a lab")

    def _post(self, path, body):
        req = urllib.request.Request(
            self.cfg["url"] + path,
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.cfg['token']}",
                # Cloudflare in front of the agent answers urllib's default "Python-urllib/3.x" with
                # 403 (error 1010, banned client signature) before the request reaches the agent.
                "user-agent": f"devops-vm-agent/{VERSION}",
            },
        )
        with urllib.request.urlopen(req, timeout=30, context=self.ssl) as res:
            raw = res.read()
            return json.loads(raw) if res.status == 200 and raw else None

    def heartbeat(self):
        body = {"units": self.cfg["units"], "version": VERSION, "snapshot": self.snap()}
        for key in ("cluster", "node"):
            if self.cfg.get(key):
                body[key] = self.cfg[key]
        self._post("/vm/heartbeat", body)

    def poll_once(self):
        action = self._post("/vm/actions/claim", {})
        if not action:
            return
        aid, unit = action.get("id"), action.get("unit", "")
        log.info("claimed action %s: %s %s", aid, action.get("action"), unit)
        if action.get("action") != "restart" or unit not in self.cfg["units"]:
            log.warning("action %s refused: %s is not in this VM's allowlist", aid, unit)
            self._post(f"/vm/actions/{aid}/result", {"status": "refused", "unit": unit})
            return
        try:
            done = self.run(["systemctl", "restart", unit], capture_output=True, text=True, timeout=60)
            code = done.returncode
        except subprocess.TimeoutExpired:
            code = -1
        active = self.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=10).stdout.strip()
        journal = self.run(["journalctl", "-u", unit, "-n", "20", "--no-pager"], capture_output=True, text=True, timeout=10).stdout
        status = "succeeded" if code == 0 else "failed"
        log.info("action %s %s: exit %s, now %s", aid, status, code, active)
        self._post(f"/vm/actions/{aid}/result", {"status": status, "exitCode": code, "active": active, "journal": journal})


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    path = sys.argv[1] if len(sys.argv) > 1 else "/etc/devops-vm-agent.conf"
    agent = Agent(load_config(path))
    last_beat = 0.0
    while True:
        try:
            if time.monotonic() - last_beat >= 60:
                agent.heartbeat()
                last_beat = time.monotonic()
            agent.poll_once()
        except (urllib.error.URLError, OSError, ValueError) as err:
            log.warning("central endpoint unreachable: %s", err)
        time.sleep(agent.cfg["poll_seconds"])


if __name__ == "__main__":
    main()
