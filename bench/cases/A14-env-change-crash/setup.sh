#!/usr/bin/env bash
# A14 — a healthy Deployment, then ONE env change rolls out a revision that crashloops.
# The case exists for the change timeline: the evidence that names the cause is the rollout
# itself (revision 2 changed QUEUE_MODE), and an RCA that does not name that change has not
# found the cause, however well it describes the crash.
set -euo pipefail
NS="bench-a14"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"
kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: invoice-worker, namespace: bench-a14, labels: { app: invoice-worker } }
spec:
  replicas: 1
  selector: { matchLabels: { app: invoice-worker } }
  template:
    metadata: { labels: { app: invoice-worker } }
    spec:
      containers:
        - name: worker
          image: busybox:1.36
          env:
            - { name: QUEUE_MODE, value: "batch" }
          command:
            - /bin/sh
            - -c
            - |
              case "$QUEUE_MODE" in
                batch|stream) echo "worker started in $QUEUE_MODE mode"; while true; do sleep 30; done ;;
                *) echo "FATAL: unsupported QUEUE_MODE=$QUEUE_MODE (expected batch|stream)" >&2; exit 1 ;;
              esac
YAML
kubectl -n "$NS" rollout status deploy/invoice-worker --timeout=120s
kubectl -n "$NS" set env deploy/invoice-worker QUEUE_MODE=streaming
echo "waiting for the new revision to crashloop..."
for _ in $(seq 1 40); do
  n=$(kubectl get pods -n "$NS" -l app=invoice-worker -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' 2>/dev/null | sort -n | tail -1)
  [ "${n:-0}" -ge 2 ] 2>/dev/null && { echo "restartCount=$n"; exit 0; }
  sleep 3
done
echo "setup failed: the new revision never restarted twice" >&2
kubectl get pods -n "$NS" -o wide >&2
exit 1
