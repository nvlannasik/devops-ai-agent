---
name: pvc-pending
description: A claim that never binds
when: pvc|persistentvolume|volume|storageclass
---

1. k8s_list_pvcs — confirm the claim is Pending (not Bound)
2. k8s_list_storageclasses — is there a default class? is the provisioner correct? (Pending + no default class = the usual cause)
3. k8s_list_pvs — Failed/Released PV, or none Available matching the claim
