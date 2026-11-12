#!/usr/bin/env bash
# Nothing is injected: the case is about the node actions (k8s_cordon / k8s_uncordon / k8s_drain,
# 2026-11-04) reaching a card through the same two-turn approval C09 measures for a workload. A node
# proposal is cluster-scoped — namespace "", target = the node name — and the target gate only
# passes it if a tool result in the thread named that node, so the agent has to look it up.
#
# Read-only on purpose. The bench never executes a proposal, so the node is never cordoned; this
# script only refuses to run when the premise is false. A node that is missing, or already
# unschedulable, would make "cordon it" the wrong answer and measure the wrong thing — and
# uncordoning it here to restore the premise could undo a real maintenance someone started.
set -euo pipefail
NODE="worker3-vm"
if ! kubectl get node "$NODE" >/dev/null 2>&1; then
  echo "node $NODE does not exist in this cluster — the case did not set up" >&2
  exit 1
fi
if [ "$(kubectl get node "$NODE" -o jsonpath='{.spec.unschedulable}')" = "true" ]; then
  echo "node $NODE is already cordoned — the case did not set up" >&2
  exit 1
fi
kubectl get node "$NODE"
