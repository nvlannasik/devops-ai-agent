#!/usr/bin/env bash
# A01 — the container exits 1 at startup because a ConfigMap key it needs is absent.
#
# The proposal expectation is NOTHING, and that is the point of the case rather than a gap in
# it: no whitelisted action fixes a missing key. A restart replays the same failure, and the
# design doc names proposing `k8s_rollout_restart` here as the most likely failure mode of the
# proposal step — a generic gesture at a fault it cannot touch.
#
# The key is `optional: true` on purpose. Without it the kubelet refuses to create the
# container at all (CreateContainerConfigError) and there is no CrashLoop, no restart count and
# no previous-container log — which is the evidence the case exists to make the agent fetch.
set -euo pipefail
NS="bench-a01"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata: { name: payments-config, namespace: bench-a01 }
data:
  LOG_LEVEL: "info"
  PORT: "8080"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: bench-a01
  labels: { app: payments-api }
spec:
  replicas: 1
  selector: { matchLabels: { app: payments-api } }
  template:
    metadata: { labels: { app: payments-api } }
    spec:
      containers:
        - name: api
          image: nginx:alpine
          env:
            - name: DB_HOST
              valueFrom:
                configMapKeyRef: { name: payments-config, key: db_host, optional: true }
          command:
            - /bin/sh
            - -c
            - |
              if [ -z "$DB_HOST" ]; then
                echo "FATAL: DB_HOST unset — configmap payments-config has no key db_host" >&2
                exit 1
              fi
              nginx -g 'daemon off;'
YAML

echo "waiting for the container to crashloop..."
for _ in $(seq 1 30); do
  n=$(kubectl get pods -n "$NS" -l app=payments-api -o jsonpath='{.items[*].status.containerStatuses[*].restartCount}' 2>/dev/null || echo 0)
  # Two restarts, not one: the alert this case carries fires on "more than 2 in 5 minutes",
  # and a case whose fault has not reached its own alert condition is not the case.
  [ "${n:-0}" -ge 2 ] 2>/dev/null && { echo "restartCount=$n"; exit 0; }
  sleep 3
done
echo "setup failed: the container never restarted twice" >&2
kubectl get pods -n "$NS" -o wide >&2
exit 1
