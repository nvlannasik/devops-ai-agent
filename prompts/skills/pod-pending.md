---
name: pod-pending
description: Reading the scheduler's own message for an unschedulable pod
when: pending|unschedulable|insufficient (cpu|memory)|taint
---

1. k8s_list_events (field_selector for the pod) — the scheduler's message ("Insufficient cpu/memory", node affinity/selector, untolerated taint)
2. k8s_describe_node (the target node, or a candidate node) — `conditions` (MemoryPressure / DiskPressure / PIDPressure / Ready), `taints`, `unschedulable`, and capacity vs allocatable; a pressured / tainted / NotReady node explains the failure to schedule
