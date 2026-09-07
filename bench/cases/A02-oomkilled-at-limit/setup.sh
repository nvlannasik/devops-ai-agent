#!/usr/bin/env bash
# Adapted from k8s-ai-bench tasks/fix-oomkilled — but NOT its workload, which does not work.
#
# Theirs runs `dd if=/dev/zero of=/tmp/cache.dat bs=1M count=150` against a 128Mi limit. /tmp is
# the container's overlayfs, so those 150Mi become PAGE CACHE, and page cache is reclaimable:
# the kernel evicts it instead of killing anything. Run on a real cluster the pod sits at 1/1
# Running with zero restarts, and the case scores the agent's miss on a fault that never
# happened. That is almost certainly why upstream ships it `disabled: true`.
#
# tmpfs was the next guess and also wrong here — an emptyDir with medium: Memory did not push
# the cgroup over its limit on this kernel. What does, measured rather than assumed, is plain
# anonymous memory: `tail /dev/zero` buffers a file with no newlines and is OOMKilled in about
# three seconds.
#
# ponytail: this injects a LEAK, not a limit set too low, so no finite limit fixes it and the
# `greaterThan` bound is a floor rather than the observed peak the design doc asks for. It
# scores identically — nothing here applies the proposal — and the cluster's own alert text
# says the ambiguity is the point: "whether the limit is too low or the code leaks is the
# question". The fixable variant is a separate case, and the catalog already names it: C02.
#
# The rest is ours: the namespace is disposable, and the script exits non-zero unless the
# kernel actually killed the container, so the agent is never asked to diagnose a fault that
# has not happened yet.
set -euo pipefail
NS="bench-a02"

kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api
  namespace: bench-a02
  labels: { app: backend-api }
spec:
  replicas: 1
  selector:
    matchLabels: { app: backend-api }
  template:
    metadata:
      labels: { app: backend-api }
    spec:
      containers:
        - name: api-server
          image: nginx:alpine
          # The allocator is the MAIN process on purpose. With nginx in the foreground and the
          # hog in the background, the cgroup OOM killer takes the child and the container
          # keeps running — no restart, no OOMKilled on the pod, nothing for the agent to find.
          command: ["/bin/sh", "-c", "echo 'starting backend service'; exec tail /dev/zero"]
          resources:
            requests: { memory: "64Mi", cpu: "50m" }
            limits:   { memory: "128Mi", cpu: "100m" }
YAML

# No rollout wait: the container is meant to die, so the Deployment never becomes Available.
echo "waiting for the container to be OOMKilled..."
for _ in $(seq 1 30); do
  # state OR lastState — the pod is either dead right now or in backoff between kills.
  reason=$(kubectl get pods -n "$NS" -l app=backend-api -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.terminated.reason} {.status.containerStatuses[*].lastState.terminated.reason} {end}' 2>/dev/null || true)
  if [[ "$reason" == *OOMKilled* ]]; then
    echo "OOMKilled observed."
    exit 0
  fi
  sleep 2
done

# Fail loudly. A task whose fault never landed would be scored as the agent's miss.
echo "setup failed: no OOMKilled within 60s" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" >&2
exit 1
