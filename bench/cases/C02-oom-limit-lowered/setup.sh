#!/usr/bin/env bash
# C02 — the same OOMKilled symptom as A02, the opposite cause.
#
# The workload allocates a FIXED 200Mi and holds it. It ran fine on a 512Mi limit; the last
# deploy lowered the limit to 128Mi and nothing else. Usage is flat — the limit moved.
#
# That distinction is the case. A02 is a genuine leak, unbounded, where no limit is enough;
# here raising the limit IS the fix, and the previous ReplicaSet still carries the 512Mi it was
# lowered from. An agent that answers both the same way has not read either.
#
# Written, not merely allocated: `b'x' * N` touches every page. `bytearray(N)` does not —
# CPython calloc's it and the pages stay copy-on-write mapped to the shared zero page, so RSS
# never rises and the container never OOMs. That cost three wrong injectors before it was
# measured rather than assumed; tmpfs and `stress --vm-hang 0` fail for related reasons.
#
# WHAT THIS CANNOT SCORE. The catalog fails this case if the RCA "proposes raising the limit
# without noting the limit was lowered deliberately" — and the proposal axis cannot see that
# distinction, because the right ACTION is the same either way. Scored here: the action, the
# target, and a limit above the working set. The half that separates C02 from A02 needs the
# root-cause axis and its judge.
set -euo pipefail
NS="bench-c02"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: bench-c02
  labels: { app: orders-api }
spec:
  replicas: 1
  selector: { matchLabels: { app: orders-api } }
  template:
    metadata: { labels: { app: orders-api } }
    spec:
      containers:
        - name: api-server
          image: python:3-alpine
          command:
            - python3
            - -c
            - |
              import time
              cache = b'x' * (200 * 1024 * 1024)
              print('warm cache ready:', len(cache), 'bytes', flush=True)
              time.sleep(3600)
          resources:
            requests: { memory: "64Mi" }
            limits:   { memory: "512Mi" }
YAML

# It has to be healthy on the old limit first, or "the limit was lowered" is not the story.
kubectl rollout status deployment/orders-api -n "$NS" --timeout=180s
echo "healthy on 512Mi. lowering the limit, changing nothing else..."
kubectl set resources deployment/orders-api -n "$NS" --containers=api-server --limits=memory=128Mi

echo "waiting for the container to be OOMKilled..."
for _ in $(seq 1 40); do
  reason=$(kubectl get pods -n "$NS" -l app=orders-api -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.terminated.reason} {.status.containerStatuses[*].lastState.terminated.reason} {end}' 2>/dev/null || true)
  case "$reason" in *OOMKilled*) echo "OOMKilled observed."; exit 0;; esac
  sleep 3
done
echo "setup failed: no OOMKilled within 120s of lowering the limit" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" >&2
exit 1
