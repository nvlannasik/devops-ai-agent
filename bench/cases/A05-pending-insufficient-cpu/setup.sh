#!/usr/bin/env bash
# A05 - a request larger than any node's allocatable CPU (the biggest node here has 4).
#
# No mustNot for the taint wording, deliberately: this cluster's master carries
# node-role.kubernetes.io/master:NoSchedule, so the real scheduler message is "1 node(s) had
# untolerated taint ..., 2 Insufficient cpu" and an RCA that quotes it is quoting evidence.
# A06 is where the taint/selector confusion is actually tested.
#
# No proposal is correct as the prompt stands: action 3 (k8s_set_resources) is scoped to
# "OOMKilled / resource-exhaustion" - a pod that never started is neither. If that scope is
# ever widened to cover lowering an impossible request, this expectation changes with it.
set -euo pipefail
NS="bench-a05"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: bench-a05
  labels: { app: orders-api }
spec:
  replicas: 1
  selector: { matchLabels: { app: orders-api } }
  template:
    metadata: { labels: { app: orders-api } }
    spec:
      containers:
        - name: api
          image: nginx:alpine
          resources:
            requests: { cpu: "64" }
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
