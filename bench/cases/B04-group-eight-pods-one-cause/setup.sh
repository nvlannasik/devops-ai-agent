#!/usr/bin/env bash
# B04 - eight alerts, one cause. A StatefulSet rather than a Deployment so the pod names are
# ordinal and the eight alert members can be written down: payments-0 .. payments-7 survive a
# restart, a ReplicaSet hash does not.
#
# What this harness can score is the ANSWER: one cause named once, for all eight. The catalog's
# other half - one investigation, one thread, one incident row, cost within 1.3x of A01 - is a
# property of the Slack path, and the runner drives investigate() directly. Left unmeasured
# rather than faked.
set -euo pipefail
NS="bench-b04"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: payments
  namespace: bench-b04
spec:
  clusterIP: None
  selector: { app: payments }
  ports: [{ port: 80 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: payments
  namespace: bench-b04
  labels: { app: payments }
spec:
  serviceName: payments
  replicas: 8
  podManagementPolicy: Parallel
  selector: { matchLabels: { app: payments } }
  template:
    metadata: { labels: { app: payments } }
    spec:
      containers:
        - name: api
          image: busybox:1.36
          command: ["sh", "-c"]
          args:
            - 'echo "FATAL: DATABASE_URL is not set, refusing to start"; sleep 3; exit 1'
YAML

# Restart COUNT, not the waiting reason: this container lives a few seconds per attempt, so a
# poll every three seconds catches it terminated as often as backing off, and .state.waiting is
# empty in that window. Measured: this wait timed out on a pod with five restarts.
echo "waiting for restarts to accumulate across the group..."
for _ in $(seq 1 40); do
  r=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[*]}{.status.containerStatuses[*].restartCount} {end}' 2>/dev/null || true)
  case "$r" in *[3-9]*|*[1-9][0-9]*) echo "restarts: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: the group never restarted" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
