---
name: pod-pending
description: Reading the scheduler's own message for an unschedulable pod
when: pending|unschedulable|insufficient (cpu|memory)|taint
---

1. k8s_list_events (field_selector for the pod) — the scheduler's message ("Insufficient cpu/memory", node affinity/selector, untolerated taint)
2. k8s_describe_node (the target node, or a candidate node) — `conditions` (MemoryPressure / DiskPressure / PIDPressure / Ready), `taints`, `unschedulable`, and capacity vs allocatable; a pressured / tainted / NotReady node explains the failure to schedule
3. **State the request and the capacity it did not fit into, both as numbers.** `requests.cpu: 64` against `allocatable: 3800m` on every node is the whole finding, and the remediation is a number below it — an RCA that stops at "insufficient CPU" leaves a human to go and read the same two fields. If it is a taint or a selector instead, name the key and value and which nodes carry it.
