---
name: pod-pending
description: Reading the scheduler's own message for an unschedulable pod
when: pending|unschedulable|insufficient (cpu|memory)|taint
---

1. k8s_list_events (field_selector for the pod) — the scheduler's message ("Insufficient cpu/memory", node affinity/selector, untolerated taint)
2. k8s_describe_node (the target node, or a candidate node) — `conditions` (MemoryPressure / DiskPressure / PIDPressure / Ready), `taints`, `unschedulable`, and capacity vs allocatable; a pressured / tainted / NotReady node explains the failure to schedule
3. **The scheduler's message decides which fact to state, and it is not always a resource one.** Read step 1's message before choosing:
   - `Insufficient cpu` / `Insufficient memory` → state the request and the capacity it did not fit into, both as numbers. `requests.cpu: 64` against `allocatable: 3800m` on every node is the whole finding, and the remediation is a number below it. **The lever is the request, not the cluster.** For a request no node can satisfy, the change that satisfies the Immediate line's two requirements is lowering it — `k8s_set_resources`, with the value on the line. Adding capacity is Long-term here, for the reason the format rule gives.
   - `unbound immediate PersistentVolumeClaims`, or any message naming a volume or claim → **this is not a capacity fault at all.** The pod is waiting on storage and will never schedule until the claim binds; `pvc-pending` is the playbook, and the facts are the claim, the StorageClass it asked for, and whether that class exists.
   - node affinity / nodeSelector / untolerated taint → name the key and value, and which nodes carry it.

   Do not reach for the CPU/memory numbers because they are the familiar ones. A Pending pod whose PVC cannot bind has a perfectly ordinary resource request, and an RCA that reports it as over-requested sends a human to change a number that was never wrong.
