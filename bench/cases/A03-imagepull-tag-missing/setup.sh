#!/usr/bin/env bash
# A03 — a deploy moved the image to a tag that does not exist.
#
# Rolled out on a WORKING tag first and then updated, rather than created broken. That is not
# realism for its own sake: the proposal prompt forbids inventing a tag ("NEVER invent a tag"),
# so a correct k8s_set_image needs a real one to point at, and the previous ReplicaSet is where
# it survives. Created broken, the only honest answer would be no proposal — a different case.
#
# `changed` rather than an exact image in the expectation: any tag but the broken one is a
# defensible fix, and pinning `nginx:alpine` would score the model for guessing what this
# script happened to choose.
set -euo pipefail
NS="bench-a03"
BROKEN="nginx:no-such-tag-9f2c"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: bench-a03
  labels: { app: storefront }
spec:
  replicas: 1
  selector: { matchLabels: { app: storefront } }
  template:
    metadata: { labels: { app: storefront } }
    spec:
      containers:
        - name: web
          image: nginx:alpine
          ports: [{ containerPort: 80 }]
YAML

kubectl rollout status deployment/storefront -n "$NS" --timeout=120s
kubectl set image deployment/storefront -n "$NS" "web=$BROKEN"

echo "waiting for ImagePullBackOff..."
for _ in $(seq 1 30); do
  r=$(kubectl get pods -n "$NS" -l app=storefront -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason} {end}' 2>/dev/null || true)
  case "$r" in *ImagePullBackOff*|*ErrImagePull*) echo "reason: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: the image pull never failed" >&2
kubectl get pods -n "$NS" -o wide >&2
exit 1
