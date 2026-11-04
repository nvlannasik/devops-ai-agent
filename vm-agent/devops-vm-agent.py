#!/usr/bin/env python3
"""devops-vm-agent — pulls approved restarts from the devops agent and runs only its own allowlist.

Spec: devops-ai-agent/docs/superpowers/specs/2026-11-04-node-ops-and-vm-agent-design.md (Part B).
The VM opens every connection (no inbound port), proves who it is with its own bearer token, and
decides for itself what may run: an action whose unit is not in `units` below is reported
`refused` and nothing is executed. The only command it ever runs is `systemctl restart <unit>`
(plus `systemctl is-active` and `journalctl` to report the result). Python 3 standard library only.
"""
import configparser
import json
import logging
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

VERSION = "1"
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
    return {
        "name": a["name"],
        "url": a["url"].rstrip("/"),
        "token": a["token"],
        "units": a.get("units", "").split(),
        "poll_seconds": int(a.get("poll_seconds", "10")),
        "ca_file": a.get("ca_file") or None,
    }


class Agent:
    def __init__(self, cfg, runner=subprocess.run):
        self.cfg = cfg
        self.run = runner
        self.ssl = ssl.create_default_context(cafile=cfg["ca_file"]) if cfg["ca_file"] else None
        if cfg["url"].startswith("http://"):
            log.warning("url is http:// — the token and the actions travel in clear; use https:// outside a lab")

    def _post(self, path, body):
        req = urllib.request.Request(
            self.cfg["url"] + path,
            data=json.dumps(body).encode(),
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.cfg['token']}"},
        )
        with urllib.request.urlopen(req, timeout=30, context=self.ssl) as res:
            raw = res.read()
            return json.loads(raw) if res.status == 200 and raw else None

    def heartbeat(self):
        self._post("/vm/heartbeat", {"units": self.cfg["units"], "version": VERSION})

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
