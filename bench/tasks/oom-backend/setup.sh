#!/usr/bin/env bash
# Adapted from k8s-ai-bench tasks/fix-oomkilled. The workload is theirs — a container that
# allocates 150Mi against a 128Mi limit — because it is a faithful OOM and there is no reason
# to invent a second one. What changed is everything around it: the namespace is disposable,
# and the script exits only once the kernel has actually killed the container, so the agent
# is never asked to diagnose a fault that has not happened yet.
set -euo pipefail
NS="bench-oom"

kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api
  namespace: bench-oom
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
          command: ["/bin/sh"]
          args:
            - -c
            - |
              echo "Starting backend service..."
              dd if=/dev/zero of=/tmp/cache.dat bs=1M count=150 &
              nginx -g 'daemon off;'
          ports: [{ containerPort: 80 }]
          resources:
            requests: { memory: "64Mi", cpu: "50m" }
            limits:   { memory: "128Mi", cpu: "100m" }
YAML

kubectl rollout status deployment/backend-api -n "$NS" --timeout=120s || true

echo "waiting for the container to be OOMKilled..."
for _ in $(seq 1 30); do
  reason=$(kubectl get pods -n "$NS" -l app=backend-api \
    -o jsonpath='{.items[*].status.containerStatuses[*].lastState.terminated.reason}' 2>/dev/null || true)
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
