#!/usr/bin/env bash
set -euo pipefail
NS="bench-d02"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"
kubectl apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: catalog-api, labels: { app: catalog-api } }
spec:
  replicas: 1
  selector: { matchLabels: { app: catalog-api } }
  template:
    metadata: { labels: { app: catalog-api } }
    spec: { containers: [{ name: api, image: "nginx:1.27-alpine", ports: [{ containerPort: 80 }] }] }
---
apiVersion: v1
kind: Service
metadata: { name: catalog-api }
spec: { selector: { app: catalog-api }, ports: [{ port: 80, targetPort: 80 }] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: catalog-api }
spec:
  rules:
    - host: catalog.bench-d02.local
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: catalog-api, port: { number: 80 } } } }] }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: price-sync }
spec:
  schedule: "*/30 * * * *"
  jobTemplate: { spec: { template: { spec: { restartPolicy: Never, containers: [{ name: sync, image: "busybox:1.36", command: ["true"] }] } } } }
YAML
kubectl -n "$NS" rollout status deploy/catalog-api --timeout=120s
