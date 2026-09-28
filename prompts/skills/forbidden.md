---
name: forbidden
description: Resolving an RBAC denial to the exact apiGroup/resource/verb
when: forbidden|permission denied|rbac|cannot (get|list|watch|create|update|patch|delete) resource
---

1. **Read the denial first — it names every part of the fix.** `User "system:serviceaccount:<ns>:<name>"
   cannot <verb> resource "<resource>" in API group "<group>"`. Quote it.
2. `k8s_get_sa_permissions` with that ServiceAccount SPLIT: `namespace: "<ns>"`, `serviceaccount:
   "<name>"`. The whole `system:serviceaccount:…` string, or a missing namespace (it defaults to
   `default`), matches no binding — and "no bindings" reads exactly like "this ServiceAccount has no
   permissions", which is a different finding.
3. Compare its resolved rules with the denied verb, resource and apiGroup (`""` is the core group).
   Missing → the fix is that rule on a Role/ClusterRole, or a binding to one: state apiGroup,
   resource, verb and namespace exactly. Present but still denied → the binding is in another
   namespace than the pod; name both.
4. RBAC for a Flux/Helm-managed workload lives in its chart, so the fix is a PR, and there is no
   approval-card action for RBAC — say so rather than implying one will follow.
