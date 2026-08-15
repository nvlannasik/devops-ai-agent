---
name: pvc-pending
description: A claim that never binds
when: pvc|storageclass
---

1. k8s_list_pvcs — confirm the claim is Pending.
