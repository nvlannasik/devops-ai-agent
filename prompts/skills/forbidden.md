---
name: forbidden
description: Resolving an RBAC denial to the exact apiGroup/resource/verb
when: forbidden|permission denied|rbac|unauthorized
---

1. k8s_get_sa_permissions (the ServiceAccount from the error, e.g. `system:serviceaccount:ns:name`) — its bound roles + resolved rules; check whether the needed apiGroup/resource/verb is granted
2. If missing: the fix is an RBAC Role/ClusterRole rule — state the exact apiGroup/resource/verb needed
