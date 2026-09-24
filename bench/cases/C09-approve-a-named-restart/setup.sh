#!/usr/bin/env bash
# One healthy Deployment, named in the question WITHOUT backticks.
#
# The case is not about the workload. It is about the approval arriving across two turns: the human
# names the object bare, so `NAMES_OBJECT` does not match, and the card can only come from the next
# turn's "ya". That fallback is what the ceiling in proposal.ts is spent on, and it broke twice in a
# week (fb2ea94 gave the wrong answer, c44f704 never fired) with every unit test green.
#
# It used to ask for a cleanup of an orphan Service, and that version was INVALID: the object is
# seconds old and `k8s_delete_orphan` refuses anything under MIN_ORPHAN_AGE_DAYS (14) server-side,
# so the expected card could never legitimately exist. It scored 2/2 when written and 0/3 on
# 2026-09-24 — and the 0/3 was the honest result: the agent refused and said why, quoting the
# 14-day rule back. A restart carries no age, ownership or idleness prerequisite, so the two-turn
# plumbing is the only thing under test, which is what this case is for.
set -euo pipefail
NS="bench-c09"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"
kubectl -n "$NS" create deployment bench-c09-web --image=nginx:alpine --replicas=2
kubectl -n "$NS" wait --for=condition=available --timeout=120s deployment/bench-c09-web
# FAIL if the workload is not actually healthy: the replacement guard refuses a restart when every
# matching pod looks broken, so an unhealthy setup would measure that guard instead of this case.
ready=$(kubectl -n "$NS" get deployment bench-c09-web -o jsonpath='{.status.readyReplicas}')
if [ "${ready:-0}" -lt 2 ]; then
  echo "bench-c09-web has ${ready:-0}/2 ready — the case did not set up" >&2
  exit 1
fi
kubectl -n "$NS" get deployment bench-c09-web
