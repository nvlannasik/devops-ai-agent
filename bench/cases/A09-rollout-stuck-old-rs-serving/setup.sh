#!/usr/bin/env bash
# A09 - the same broken tag as A03, deliberately, in the state that changes the answer: three
# replicas with maxUnavailable 25% (which rounds DOWN to 0), so the old ReplicaSet keeps every
# one of its pods and traffic never stops. The rollout is stuck; the service is not down.
#
# That distinction is the case. An agent that reports a full outage here is wrong in the
# direction that wakes people at 3am, so the impact claim is scored, not just the fix.
#
# The proposal expectation is a rollback, and it is honest only because the working tag is in
# the trace: the previous ReplicaSet still carries nginx:alpine.
set -euo pipefail
NS="bench-a09"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: bench-a09
  labels: { app: web-frontend }
spec:
  replicas: 3
  progressDeadlineSeconds: 60
  strategy:
    rollingUpdate: { maxSurge: 1, maxUnavailable: 25% }
  selector: { matchLabels: { app: web-frontend } }
  template:
    metadata: { labels: { app: web-frontend } }
    spec:
      containers:
        - name: web
          image: nginx:alpine
          ports: [{ containerPort: 80 }]
YAML

kubectl rollout status deployment/web-frontend -n "$NS" --timeout=180s
kubectl set image deployment/web-frontend -n "$NS" web=nginx:no-such-tag-a09

echo "waiting for the new ReplicaSet to fail its pull..."
for _ in $(seq 1 30); do
  r=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason} {end}' 2>/dev/null || true)
  case "$r" in *ImagePullBackOff*|*ErrImagePull*) echo "reason: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: the new ReplicaSet to fail its pull never happened" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
