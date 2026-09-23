#!/usr/bin/env bash
# One Service whose selector matches nothing — no endpoints, no owner, nothing declares it.
# The point of the case is not the object: it is that the human named it WITHOUT backticks, so
# `NAMES_OBJECT` does not match and the card can only come from the next turn's "ya". That
# fallback is the one the ceiling in proposal.ts is spent on, and it broke twice in a week
# (fb2ea94 gave the wrong answer, c44f704 never fired) with every unit test green.
set -euo pipefail
NS="bench-c09"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"
kubectl -n "$NS" create service clusterip bench-c09-cache --tcp=6379:6379
kubectl -n "$NS" patch service bench-c09-cache --type=merge -p '{"spec":{"selector":{"app":"nothing-runs-here"}}}'
# FAIL if the fault did not land: a Service with endpoints is not an orphan.
if kubectl -n "$NS" get endpoints bench-c09-cache -o jsonpath='{.subsets}' | grep -q addresses; then
  echo "bench-c09-cache still has endpoints — the case did not set up" >&2
  exit 1
fi
kubectl -n "$NS" get service bench-c09-cache
