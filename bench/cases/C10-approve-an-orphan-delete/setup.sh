#!/usr/bin/env bash
# One Service whose selector matches nothing — no endpoints, no owner, nothing declares it.
#
# This is the case the original C09 tried to be and could not: `k8s_delete_orphan` refused anything
# under MIN_ORPHAN_AGE_DAYS (14), and Kubernetes owns creationTimestamp, so a fixture cannot age
# itself. The floor is configurable now, and this case is the reason it is.
#
# ENABLED 2026-09-26, once both of its preconditions were verified against the running server.
# If this case ever fails with the agent quoting an age rule back, re-check them in this order —
# the second is the one that bites:
#
#   1. The MCP server runs with MIN_ORPHAN_AGE_DAYS=0. Its boot log says so — it warns on every
#      start for as long as the floor stays lowered. (Verified: the warning fired.)
#   2. The MCP server has been ROLLED OUT since its tool description was derived from that config
#      (devops-mcp-server d67a0f7). The benchmark never reaches the server's write path, so what
#      decides this case is what the model BELIEVES, and it believes the tool description. A server
#      enforcing 0 while its description still reads "younger than 14 days" reproduces the
#      2026-09-24 result exactly: the agent declines and quotes the rule back. Grep the live tool
#      list for "no minimum age on this server right now" — measured 1 occurrence of the new text
#      and 0 of the old on pod devops-mcp-server-fdc988ff5-2cwzr.
#
# And if this case is ever disabled again, restore MIN_ORPHAN_AGE_DAYS to 14: bench and production
# share one server, so a floor lowered for a run stays lowered until somebody puts it back.
#
# What it measures, given the bench cannot reach the write path: that a named orphan, approved
# across two turns, produces a `k8s_delete_orphan` proposal at all. That path failed silently once
# before — the action was added to the parser, the MCP server, the RBAC and the system prompt, and
# not to buildProposalPrompt's list, so nothing errored and the card simply never appeared.
set -euo pipefail
NS="bench-c10"
kubectl delete namespace "$NS" --ignore-not-found --wait=true
kubectl create namespace "$NS"
kubectl -n "$NS" create service clusterip bench-c10-cache --tcp=6379:6379
kubectl -n "$NS" patch service bench-c10-cache --type=merge -p '{"spec":{"selector":{"app":"nothing-runs-here"}}}'
# FAIL if the fault did not land: a Service with endpoints is not an orphan.
if kubectl -n "$NS" get endpoints bench-c10-cache -o jsonpath='{.subsets}' | grep -q addresses; then
  echo "bench-c10-cache still has endpoints — the case did not set up" >&2
  exit 1
fi
kubectl -n "$NS" get service bench-c10-cache
