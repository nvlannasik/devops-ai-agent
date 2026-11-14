#!/usr/bin/env bash
# A16 — a node left cordoned after maintenance, and a workload that may only run there.
#
# The node is healthy: Ready, no pressure condition, nothing evicted. The only thing wrong with it is
# `spec.unschedulable`, and the scheduler says so ("node(s) were unschedulable"). The repair is an
# uncordon, which is the one case the proposal prompt allows it for — a node whose cordon no fault
# explains. Note what the agent has to read to see it: `k8s_list_nodes` carries Ready only; the
# cordon is in `k8s_describe_node` and in the scheduler's event.
#
# This one TOUCHES A REAL NODE, so the rules are strict:
# - worker3-vm is cordoned for the length of one attempt (a few minutes). Running pods stay; new
#   pods go to the other two workers. Nothing in this cluster is pinned to worker3-vm.
# - The cordon is marked with an annotation, and cleanup.sh uncordons ONLY a node carrying that
#   mark. A node somebody else cordoned is refused here and never touched by cleanup.
# - A run killed mid-attempt leaves the mark behind, so the next setup recognises the cordon as
#   the bench's own and lifts it before starting.
set -euo pipefail
NS="bench-a16"
NODE="worker3-vm"
MARK="bench.devops-ai/cordoned-by"

kubectl get node "$NODE" >/dev/null 2>&1 || { echo "node $NODE does not exist — the case did not set up" >&2; exit 1; }
if [ "$(kubectl get node "$NODE" -o jsonpath='{.spec.unschedulable}')" = "true" ]; then
  if [ -n "$(kubectl get node "$NODE" -o jsonpath="{.metadata.annotations.bench\.devops-ai/cordoned-by}")" ]; then
    echo "$NODE is still cordoned by an earlier bench run — lifting it first"
    kubectl uncordon "$NODE"
    kubectl annotate node "$NODE" "$MARK-"
  else
    echo "node $NODE is cordoned by someone else — refusing to touch it" >&2
    exit 1
  fi
fi
ready=$(kubectl get node "$NODE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
[ "$ready" = "True" ] || { echo "node $NODE is not Ready ($ready) — the premise is false" >&2; exit 1; }

kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl annotate node "$NODE" "$MARK=A16" --overwrite
kubectl cordon "$NODE"

kubectl apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: report-renderer
  namespace: $NS
  labels: { app: report-renderer }
spec:
  replicas: 1
  selector: { matchLabels: { app: report-renderer } }
  template:
    metadata: { labels: { app: report-renderer } }
    spec:
      nodeSelector: { kubernetes.io/hostname: $NODE }
      containers:
        - name: renderer
          image: nginx:alpine
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 64Mi }
YAML

echo "waiting for the scheduler to say the node is unschedulable..."
for _ in $(seq 1 30); do
  if kubectl get events -n "$NS" --field-selector reason=FailedScheduling -o jsonpath='{.items[*].message}' 2>/dev/null | grep -q "unschedulable"; then
    echo "FailedScheduling: node(s) were unschedulable"
    exit 0
  fi
  sleep 2
done
echo "setup failed: no FailedScheduling naming an unschedulable node within 60s" >&2
kubectl get events -n "$NS" >&2
exit 1
