#!/usr/bin/env bash
# A07 - the fault is one level below the alert. The pod is Pending, but nothing about the pod
# is wrong: its claim never bound because it names a StorageClass this cluster does not have.
# The case fails an agent that stops at "pod is pending" and never follows the volume chain,
# which is why the expectation names the class: quoting `gp3-nonexistent` is only possible
# after reading the PVC.
set -euo pipefail
NS="bench-a07"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ledger-data
  namespace: bench-a07
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3-nonexistent
  resources: { requests: { storage: 1Gi } }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ledger
  namespace: bench-a07
  labels: { app: ledger }
spec:
  replicas: 1
  selector: { matchLabels: { app: ledger } }
  template:
    metadata: { labels: { app: ledger } }
    spec:
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: ledger-data }
      containers:
        - name: ledger
          image: nginx:alpine
          volumeMounts: [{ name: data, mountPath: /data }]
YAML

echo "waiting for a Pending pod..."
for _ in $(seq 1 20); do
  r=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[*]}{.status.phase} {end}' 2>/dev/null || true)
  case "$r" in *Pending*) echo "reason: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: a Pending pod never happened" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
