#!/usr/bin/env bash
# Uncordons ONLY a node carrying the bench's own mark — never one a person cordoned.
NODE="worker3-vm"
MARK="bench.devops-ai/cordoned-by"
if [ "$(kubectl get node "$NODE" -o jsonpath="{.metadata.annotations.bench\.devops-ai/cordoned-by}" 2>/dev/null)" = "A16" ]; then
  kubectl uncordon "$NODE"
  kubectl annotate node "$NODE" "$MARK-"
fi
kubectl delete namespace bench-a16 --ignore-not-found --wait=false
