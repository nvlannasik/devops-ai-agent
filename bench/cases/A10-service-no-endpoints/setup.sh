#!/usr/bin/env bash
# A10 — the Service selects a label nothing carries. The pods are perfectly healthy.
#
# The trap the design doc names: blame the pods. They are Ready, their logs are clean, and
# every pod-shaped tool returns green — the fault is one line in the Service, which is only
# visible by comparing the selector to the labels.
#
# No proposal is correct. Editing a selector is not a whitelisted action, and none of the five
# that are would help: restarting healthy pods, scaling them, or changing their image all leave
# the Service selecting a label that still matches nothing.
set -euo pipefail
NS="bench-a10"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: bench-a10
  labels: { app: api }
spec:
  replicas: 2
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: nginx:alpine
          ports: [{ containerPort: 80 }]
          readinessProbe:
            httpGet: { path: /, port: 80 }
            initialDelaySeconds: 2
            periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: bench-a10 }
spec:
  # The whole fault: the pods are labelled app=api.
  selector: { app: api-v2 }
  ports: [{ port: 80, targetPort: 80 }]
YAML

kubectl rollout status deployment/api -n "$NS" --timeout=120s
kubectl wait --for=condition=Ready pod -l app=api -n "$NS" --timeout=60s

# Both halves, or the case is not what it claims: healthy pods AND an empty Service.
eps=$(kubectl get endpoints api -n "$NS" -o jsonpath='{.subsets}' 2>/dev/null || true)
if [ -n "$eps" ]; then
  echo "setup failed: the Service has endpoints, so the selector is not mismatched" >&2
  kubectl get endpoints api -n "$NS" -o yaml >&2
  exit 1
fi
echo "pods Ready, Service endpoints empty."
