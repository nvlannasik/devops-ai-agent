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
            # sleep 15, not 3, and that number is the whole reason this case can be scored.
            #
            # The fact B04 turns on is this line, and the agent reads it from the kubelet or from
            # Loki. The kubelet loses it: containerd garbage-collects a dead container's log file,
            # so `previous: true` comes back "unable to retrieve container logs" — 126 characters,
            # every attempt, measured. That leaves Loki, and fluentbit discovers new files on a
            # 5-second `Refresh_Interval` while a container that logged and exited after 3 seconds
            # left a file that lived 3. The scan missed it more often than it caught it.
            #
            # Measured 2026-09-26: Loki held ZERO streams for `bench-b04` across an entire run, so
            # the evidence this case scores was available through neither channel and the failure
            # was the fixture's, not the model's. 15 seconds is three scan intervals.
            - 'echo "FATAL: DATABASE_URL is not set, refusing to start"; sleep 15; exit 1'
YAML

# Restart COUNT, not the waiting reason: this container lives a few seconds per attempt, so a
# poll every three seconds catches it terminated as often as backing off, and .state.waiting is
# empty in that window. Measured: this wait timed out on a pod with five restarts.
echo "waiting for restarts to accumulate across the group..."
# 60 × 3s, not 40: each crash cycle now carries the 15-second sleep above, so reaching the third
# restart costs roughly 115s against the 79s it used to. The old 120s ceiling would have turned a
# working fixture into "setup failed: the group never restarted".
for _ in $(seq 1 60); do
  r=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[*]}{.status.containerStatuses[*].restartCount} {end}' 2>/dev/null || true)
  case "$r" in *[3-9]*|*[1-9][0-9]*) echo "restarts: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: the group never restarted" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
