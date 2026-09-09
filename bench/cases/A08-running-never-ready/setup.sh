#!/usr/bin/env bash
# A08 - the container is healthy and the probe is wrong. Stock nginx answers 404 on /healthz,
# so the pod runs forever and never goes Ready, with restartCount 0.
#
# The third `must` is the catalog's Ruled Out requirement: not ready and crashing are different
# states with different fixes, and the restart count is the evidence that separates them. An
# RCA that says "crashing" here is wrong about a fact kubectl prints in the first column.
set -euo pipefail
NS="bench-a08"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: bench-a08
  labels: { app: storefront }
spec:
  replicas: 1
  selector: { matchLabels: { app: storefront } }
  template:
    metadata: { labels: { app: storefront } }
    spec:
      containers:
        - name: web
          image: nginx:alpine
          ports: [{ containerPort: 80 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 80 }
            initialDelaySeconds: 2
            periodSeconds: 5
YAML

echo "waiting for a Running pod that is not Ready..."
for _ in $(seq 1 25); do
  r=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[*]}{.status.phase}/{.status.containerStatuses[*].ready} {end}' 2>/dev/null || true)
  case "$r" in *Running/false*) echo "reason: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: a Running pod that is not Ready never happened" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
