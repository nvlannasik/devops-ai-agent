#!/usr/bin/env bash
# A04 - the same alert and the same symptom as A03, a different root cause: the registry says
# 403, not "no such tag". The case exists to catch an agent that answers from the ALERT NAME
# instead of the event message; scored on the proposal alone it is indistinguishable from A03,
# which is why it carries an rca expectation and A03 does not.
#
# ghcr.io out of three candidates measured on this cluster: it is the only one whose message is
# unambiguously about authorization. Docker Hub says "repository does not exist or may require
# authorization" - a message that would let a wrong answer score as right.
#
# No proposal is correct: none of the five whitelisted actions creates an imagePullSecret.
set -euo pipefail
NS="bench-a04"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-gateway
  namespace: bench-a04
  labels: { app: checkout-gateway }
spec:
  replicas: 1
  selector: { matchLabels: { app: checkout-gateway } }
  template:
    metadata: { labels: { app: checkout-gateway } }
    spec:
      containers:
        - name: gateway
          image: ghcr.io/nvlannasik/private-thing:v1
YAML

echo "waiting for ImagePullBackOff..."
for _ in $(seq 1 30); do
  r=$(kubectl get pods -n "$NS" -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason} {end}' 2>/dev/null || true)
  case "$r" in *ImagePullBackOff*|*ErrImagePull*) echo "reason: $r"; exit 0;; esac
  sleep 3
done
echo "setup failed: ImagePullBackOff never happened" >&2
kubectl get pods -n "$NS" -o wide >&2
kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -20 >&2
exit 1
