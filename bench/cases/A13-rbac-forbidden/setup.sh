#!/usr/bin/env bash
# A13 - the workload is healthy, the API server is refusing it. Grade 3 in the catalog needs the
# exact verb and resource ("cannot list pods"), not "permissions issue", which is why the
# expectation names both.
#
# A log alert, labelled source: loki, because that is how this fault surfaces: nothing crashes,
# nothing restarts, and every probe passes. The label is what selects the log-alert playbook -
# it is set by the rule author, not guessed from the alert name.
set -euo pipefail
NS="bench-a13"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"

kubectl apply -f - <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: reporter
  namespace: bench-a13
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: reporter
  namespace: bench-a13
rules:
  # get on configmaps and nothing else: enough to prove the binding works, not enough to list pods
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: reporter
  namespace: bench-a13
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: reporter }
subjects: [{ kind: ServiceAccount, name: reporter, namespace: bench-a13 }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reporter
  namespace: bench-a13
  labels: { app: reporter }
spec:
  replicas: 1
  selector: { matchLabels: { app: reporter } }
  template:
    metadata: { labels: { app: reporter } }
    spec:
      serviceAccountName: reporter
      containers:
        - name: reporter
          image: curlimages/curl:8.5.0
          command: ["sh", "-c"]
          args:
            - 'while true; do echo "$(date -Iseconds) checking pods"; curl -s --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" https://kubernetes.default.svc/api/v1/namespaces/bench-a13/pods; echo; sleep 15; done'
YAML

kubectl rollout status deployment/reporter -n "$NS" --timeout=180s
echo "waiting for the Forbidden line to appear in the log..."
for _ in $(seq 1 20); do
  if kubectl logs -n "$NS" deployment/reporter --tail=50 2>/dev/null | grep -q "is forbidden"; then
    kubectl logs -n "$NS" deployment/reporter --tail=5
    exit 0
  fi
  sleep 3
done
echo "setup failed: the reporter never logged a Forbidden response" >&2
kubectl logs -n "$NS" deployment/reporter --tail=20 >&2
exit 1
