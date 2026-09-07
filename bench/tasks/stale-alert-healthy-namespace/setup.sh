#!/usr/bin/env bash
# Nothing is broken here, and that is the task.
#
# k8s-ai-bench has no scenario of this shape: every one of its 26 verifiers asks whether the
# cluster was CHANGED, so an agent that proposes a fix for a healthy namespace cannot be
# distinguished from one that got it right. That is not a hypothetical gap — this system
# shipped exactly that bug (an approval card raised against a namespace whose every pod was
# Running, because an Indonesian negation read as fault evidence), and a suite of positive
# tasks would have scored it perfectly.
set -euo pipefail
NS="bench-healthy"

kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: bench-healthy
  labels: { app: web }
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:alpine
          ports: [{ containerPort: 80 }]
          resources:
            requests: { memory: "32Mi", cpu: "20m" }
            limits:   { memory: "64Mi", cpu: "100m" }
          readinessProbe:
            httpGet: { path: /, port: 80 }
            initialDelaySeconds: 2
            periodSeconds: 3
YAML

kubectl rollout status deployment/web -n "$NS" --timeout=120s
kubectl wait --for=condition=Ready pod -l app=web -n "$NS" --timeout=60s
echo "namespace is healthy; the alert is stale."
