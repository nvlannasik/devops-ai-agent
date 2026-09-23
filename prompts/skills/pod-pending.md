---
name: pod-pending
description: Reading the scheduler's own message for an unschedulable pod
when: pending|unschedulable|insufficient (cpu|memory)|taint
---

1. k8s_list_events (field_selector for the pod) — the scheduler's message ("Insufficient cpu/memory", node affinity/selector, untolerated taint)
2. k8s_describe_node (the target node, or a candidate node) — `conditions` (MemoryPressure / DiskPressure / PIDPressure / Ready), `taints`, `unschedulable`, and capacity vs allocatable; a pressured / tainted / NotReady node explains the failure to schedule
3. **The scheduler's message decides which fact to state, and it is not always a resource one.** Read step 1's message before choosing:
   - `Insufficient cpu` / `Insufficient memory` → state the request and the capacity it did not fit into, both as numbers. `requests.cpu: 64` against `allocatable: 3800m` on every node is the whole finding, and the remediation is a number below it. **Recommend the request, not the cluster.** Adding a worker node, enabling the autoscaler and rebalancing workloads are all reasonable things for a human to do, and none of them is a change this agent can make — put them under Long-term if they belong anywhere. The Immediate action on a request that no node in the cluster can satisfy is to lower the request to a value that fits: a `k8s_set_resources` change, reversible, and the one thing here that can actually be approved. An RCA whose only recommendation is "add capacity" leaves the pod Pending and hands the approval step nothing to offer.
   - `unbound immediate PersistentVolumeClaims`, or any message naming a volume or claim → **this is not a capacity fault at all.** The pod is waiting on storage and will never schedule until the claim binds; `pvc-pending` is the playbook, and the facts are the claim, the StorageClass it asked for, and whether that class exists.
   - node affinity / nodeSelector / untolerated taint → name the key and value, and which nodes carry it.

   Do not reach for the CPU/memory numbers because they are the familiar ones. A Pending pod whose PVC cannot bind has a perfectly ordinary resource request, and an RCA that reports it as over-requested sends a human to change a number that was never wrong.
