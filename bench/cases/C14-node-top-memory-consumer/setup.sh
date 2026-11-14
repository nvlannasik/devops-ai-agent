#!/usr/bin/env bash
# C14 — "which pod is eating memory on node X". The answer is a live number, not a spec field.
#
# `cache-warmer` holds ~300Mi on worker3-vm with a REQUEST of 32Mi, so it is the biggest user on
# that node and one of the smallest by request: an answer built from requests or limits (the spec,
# which k8s_list_pods / k8s_describe_* show) names the wrong pod. The real consumers there sit at
# ~140Mi and below (calico-node, settlement-worker), measured 2026-11-14.
#
# Before 2026-11-14 no tool could answer this in one call: k8s_list_pods has no node filter, and
# node-exporter keys its series by instance IP. k8s_node_pods joins both.
#
# settleSeconds is 90 so cAdvisor has scraped the container at its full size at least once.
# 300Mi on a 2Gi node with ~1.1Gi available — measured before writing this, refused below if the
# node is short of memory or cordoned.
set -euo pipefail
NS="bench-c14"
NODE="worker3-vm"
kubectl get node "$NODE" >/dev/null 2>&1 || { echo "node $NODE does not exist — the case did not set up" >&2; exit 1; }
[ "$(kubectl get node "$NODE" -o jsonpath='{.spec.unschedulable}')" != "true" ] || { echo "node $NODE is cordoned" >&2; exit 1; }
[ "$(kubectl get node "$NODE" -o jsonpath='{.status.conditions[?(@.type=="MemoryPressure")].status}')" != "True" ] || { echo "node $NODE is under MemoryPressure — not adding to it" >&2; exit 1; }

kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"
kubectl apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache-warmer
  namespace: $NS
  labels: { app: cache-warmer }
spec:
  replicas: 1
  selector: { matchLabels: { app: cache-warmer } }
  template:
    metadata: { labels: { app: cache-warmer } }
    spec:
      nodeSelector: { kubernetes.io/hostname: $NODE }
      containers:
        - name: warmer
          image: python:3-alpine
          # Written, not merely allocated — see C02: bytearray() pages stay copy-on-write and RSS never rises.
          command: ["python3", "-c", "import time\ncache = b'x' * (300 * 1024 * 1024)\nprint('cache warm', len(cache), flush=True)\ntime.sleep(3600)"]
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { memory: 400Mi }
YAML
kubectl rollout status deployment/cache-warmer -n "$NS" --timeout=180s
kubectl logs -n "$NS" deploy/cache-warmer --tail=1 | grep -q "cache warm" || { echo "setup failed: the cache was not written" >&2; exit 1; }
echo "cache-warmer holds ~300Mi on $NODE"
