#!/usr/bin/env bash
# C13 — the same word as node pressure ("Evicted"), a different cause.
#
# The kubelet evicts a pod in two unrelated situations: the NODE is short of memory, disk or PIDs
# (a pressure condition, and the victim is chosen by QoS — rarely the culprit), or the POD went over
# its own `ephemeral-storage` limit (the message names the limit, and the pod is the culprit). The
# node-pressure playbook is written for the first; this case is the second, and the node is fine.
# An agent that sees "Evicted" and reaches for the node — DiskPressure, a cordon, a drain — has
# answered the word instead of the message.
#
# No whitelisted action changes an ephemeral-storage limit (k8s_set_resources takes cpu/memory),
# and a restart re-runs the same writer, so the correct proposal is none.
#
# Writes ~120MB per pod lifetime to the node's disk, removed with the evicted pod. One replica.
set -euo pipefail
NS="bench-c13"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thumbnailer
  namespace: bench-c13
  labels: { app: thumbnailer }
spec:
  replicas: 1
  selector: { matchLabels: { app: thumbnailer } }
  template:
    metadata: { labels: { app: thumbnailer } }
    spec:
      containers:
        - name: thumbnailer
          image: busybox:1.36
          command: ["/bin/sh", "-c", "echo 'warming thumbnail cache'; dd if=/dev/zero of=/tmp/cache.bin bs=1M count=120; echo 'cache ready'; sleep 3600"]
          resources:
            requests: { cpu: 10m, memory: 16Mi, ephemeral-storage: 20Mi }
            limits: { memory: 64Mi, ephemeral-storage: 50Mi }
YAML

echo "waiting for the kubelet to evict a pod over its storage limit..."
for _ in $(seq 1 45); do
  msg=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[?(@.status.reason=="Evicted")]}{.status.message}{"\n"}{end}' 2>/dev/null | head -1)
  if [ -n "$msg" ]; then
    echo "evicted: $msg"
    case "$msg" in *ephemeral*|*"local storage"*) exit 0;; esac
    echo "setup failed: evicted for another reason — the node itself may be under pressure" >&2
    exit 1
  fi
  sleep 4
done
echo "setup failed: no eviction within 180s" >&2
kubectl get pods -n "$NS" -o wide >&2
exit 1
