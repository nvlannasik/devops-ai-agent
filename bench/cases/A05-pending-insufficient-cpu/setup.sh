#!/usr/bin/env bash
# A05 - a request larger than any node's allocatable CPU (the biggest node here has 4).
#
# No mustNot for the taint wording, deliberately: this cluster's master carries
# node-role.kubernetes.io/master:NoSchedule, so the real scheduler message is "1 node(s) had
# untolerated taint ..., 2 Insufficient cpu" and an RCA that quotes it is quoting evidence.
# A06 is where the taint/selector confusion is actually tested.
#
# The expectation is k8s_set_resources, lowering the request. It was written as "no proposal"
# first, on the reading that action 3 is scoped to OOMKilled - and the first live attempt
# answered with cpu_request=250m, cpu_limit=500m on the right workload, which is the fix. The
# case was wrong, not the answer, so the expectation follows the answer and action 3's scope in
# the prompt now names this shape explicitly.
#
# `changed` rather than a pinned value: any request a node can satisfy is a defensible fix, and
# 64 is the broken one.
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
