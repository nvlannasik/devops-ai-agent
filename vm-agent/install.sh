#!/usr/bin/env bash
# Installs (or upgrades) devops-vm-agent on this VM. Run as root.
#
#   sudo ./install.sh --token <token> --units "nginx.service orders.service"
#   curl -fsSL https://raw.githubusercontent.com/nvlannasik/devops-ai-agent/main/vm-agent/install.sh \
#     | sudo VM_AGENT_TOKEN=<token> bash -s -- --units "chrony.service"
#
# Options: --name (default: hostname)  --url (default: https://agent.annasik.cloud)  --poll  --ca-file
# Re-running with no --token keeps the existing config and only upgrades the script.
# --uninstall stops the service and removes everything it installed.
set -euo pipefail

RAW="https://raw.githubusercontent.com/nvlannasik/devops-ai-agent/main/vm-agent"
BIN=/usr/local/bin/devops-vm-agent.py
CONF=/etc/devops-vm-agent.conf
UNIT=/etc/systemd/system/devops-vm-agent.service

name="$(hostname)"
url="https://agent.annasik.cloud"
token="${VM_AGENT_TOKEN:-}"
units=""
poll=10
ca_file=""
uninstall=0

die() { echo "install.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --units) units="$2"; shift 2 ;;
    --poll) poll="$2"; shift 2 ;;
    --ca-file) ca_file="$2"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
command -v systemctl >/dev/null || die "systemd is required"

if [ "$uninstall" -eq 1 ]; then
  systemctl disable --now devops-vm-agent 2>/dev/null || true
  rm -f "$BIN" "$CONF" "$UNIT"
  systemctl daemon-reload
  echo "devops-vm-agent removed"
  exit 0
fi

command -v python3 >/dev/null || die "python3 is required (standard library only)"

# Files next to this script when run from a checkout; otherwise fetched from the repo.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
fetch() { # fetch <file> <dest> <mode>
  if [ -n "$here" ] && [ -f "$here/$1" ]; then
    install -m "$3" "$here/$1" "$2"
  else
    local tmp
    tmp="$(mktemp)"
    curl -fsSL "$RAW/$1" -o "$tmp" || { rm -f "$tmp"; die "cannot download $RAW/$1"; }
    install -m "$3" "$tmp" "$2"
    rm -f "$tmp"
  fi
}

fetch devops-vm-agent.py "$BIN" 0755
fetch devops-vm-agent.service "$UNIT" 0644

if [ -n "$token" ]; then
  [ -n "$units" ] || die "--units is required (the only units the agent may restart here)"
  for u in $units; do
    systemctl cat "$u" >/dev/null 2>&1 || echo "warning: unit $u is not known to systemd on this VM" >&2
  done
  case "$url" in http://*) echo "warning: $url is plain HTTP — the token travels unencrypted" >&2 ;; esac
  (
    umask 077
    {
      echo "[agent]"
      echo "name = $name"
      echo "url = $url"
      echo "token = $token"
      echo "units = $units"
      echo "poll_seconds = $poll"
      if [ -n "$ca_file" ]; then echo "ca_file = $ca_file"; fi
    } > "$CONF"
  )
  chmod 0600 "$CONF"
elif [ ! -f "$CONF" ]; then
  die "no $CONF yet: pass --token (or VM_AGENT_TOKEN) and --units"
else
  echo "keeping existing $CONF"
fi

systemctl daemon-reload
systemctl enable devops-vm-agent >/dev/null 2>&1
systemctl restart devops-vm-agent
sleep 2
if systemctl is-active --quiet devops-vm-agent; then
  echo "devops-vm-agent running as '$(sed -n 's/^name = //p' "$CONF")' — logs: journalctl -u devops-vm-agent -f"
else
  journalctl -u devops-vm-agent -n 20 --no-pager >&2 || true
  die "devops-vm-agent did not start"
fi
