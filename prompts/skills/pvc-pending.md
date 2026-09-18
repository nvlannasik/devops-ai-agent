---
name: pvc-pending
description: A claim that never binds
when: pvc|persistentvolume|volume|storageclass
---

1. k8s_list_pvcs — confirm the claim is Pending (not Bound)
2. k8s_list_storageclasses — is there a default class? is the provisioner correct? (Pending + no default class = the usual cause)
3. k8s_list_pvs — Failed/Released PV, or none Available matching the claim
4. **Name the StorageClass the claim asked for and the one the cluster would have used.** "No matching StorageClass" is not actionable; `the claim names `fast-ssd`, the cluster has only `local-path` (default)` is. State the requested size too — a claim can also be Pending because nothing that large is available.
