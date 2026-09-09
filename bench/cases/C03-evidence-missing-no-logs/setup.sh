#!/usr/bin/env bash
# C03 - a real fault with no evidence. The container exits 1 having written nothing, so
# kubectl logs is empty and Loki has no stream to return: every log query this run makes comes
# back successfully with nothing in it, which is indistinguishable from "the service is quiet"
# unless the agent says so.
#
# The correct answer names the gap and lowers its confidence. The mustNot is the second half of
# that: an RCA that reaches High confidence off an exit code alone has not noticed what it is
# missing. The catalog's hard fail - a quoted log line that appears in no tool result - is not
# scored here; groundingGaps() checks resource NAMES, not quoted lines.
set -euo pipefail
NS="bench-c03"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: settlement-worker
  namespace: bench-c03
  labels: { app: settlement-worker }
spec:
  replicas: 1
  selector: { matchLabels: { app: settlement-worker } }
  template:
    metadata: { labels: { app: settlement-worker } }
    spec:
      containers:
        - name: worker
          image: busybox:1.36
          command: ["sh", "-c"]
          args: ["sleep 3; exit 1"]
YAML

# Restart COUNT, not the waiting reason: this container lives for three seconds per attempt, so
# a poll every three seconds catches it terminated as often as backing off, and .state.waiting
# is empty in that window. Three restarts is also what the alert this case carries asserts.
echo "waiting for restarts to accumulate..."
for _ in $(seq 1 40); do
  r=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[*]}{.status.containerStatuses[*].restartCount} {end}' 2>/dev/null || true)
  case "$r" in *[3-9]*|*[1-9][0-9]*) echo "restarts: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: the worker never restarted" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
