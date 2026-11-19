#!/usr/bin/env bash
# Read-only case: nothing to clean up.
# systemd service (Kubespray), so the only place its memory shows is node_host_snapshot — run the
# bench with BENCH_HOST_SNAPSHOTS=kubectl and VM_AGENT_TOKENS set (src/bench/host-snapshots.ts).
exit 0
