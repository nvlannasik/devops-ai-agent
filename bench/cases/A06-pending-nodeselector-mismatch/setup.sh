#!/usr/bin/env bash
# A06 - the same alert as A05 with a different scheduler message. The pair is the point: an
# agent that has learned "Pending means the cluster is full" answers A05 correctly and A06
# wrongly, and only the rca axis can tell those two apart.
#
# The mustNot is safe here in a way it would not be in A05: no node is short of CPU for a pod
# that requests none, so "Insufficient cpu" cannot appear in any tool result this run.
set -euo pipefail
NS="bench-a06"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: settlement-worker
  namespace: bench-a06
  labels: { app: settlement-worker }
spec:
  replicas: 1
  selector: { matchLabels: { app: settlement-worker } }
  template:
    metadata: { labels: { app: settlement-worker } }
    spec:
      nodeSelector: { disktype: nvme-none }
      containers:
        - name: worker
          image: nginx:alpine
YAML

echo "waiting for FailedScheduling..."
for _ in $(seq 1 20); do
  r=$(kubectl get events -n "$NS" -o jsonpath='{range .items[*]}{.reason} {end}' 2>/dev/null || true)
  case "$r" in *FailedScheduling*) echo "reason: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: FailedScheduling never happened" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
