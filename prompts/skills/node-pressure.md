---
name: node-pressure
description: A node under memory, disk or PID pressure — the pod that dies is rarely the pod that caused it
when: memorypressure|diskpressure|pidpressure|node ?not ?ready|nodenotready|evicted|eviction|kubelet|node pressure|unreachable|disk full|node down
---

The eviction victim is chosen by QoS and overage, not by blame. A `BestEffort` pod with no
requests dies first even when the memory was taken by something else entirely. **Never name the
evicted pod as the cause** — find what actually grew.

1. `k8s_describe_node` — `conditions` (MemoryPressure / DiskPressure / PIDPressure / Ready),
   `taints`, and capacity vs allocatable. The condition's own message says which resource and by
   how much.
2. `prometheus_query` — what is actually consuming it on that node:
   `topk(5, sum by (pod) (container_memory_working_set_bytes{node="<node>",container!=""}))`.
   The top consumer and the evicted pod are usually different pods; say both, and say which is
   which.
3. `k8s_list_events` with `since_minutes: 60` — `Evicted`, `SystemOOM`, `FailedScheduling`. The
   eviction event names the threshold that was crossed.
4. `k8s_recommend_resources` for the top consumer — an eviction loop is a sizing fault most of
   the time, and this gives the number to change rather than "reduce memory usage".

**`Ready: Unknown` is not pressure.** It means the kubelet stopped reporting: the node may be
fine and unreachable, or down. Its pods will sit `Terminating` until the node returns. That is a
node/network incident and the pods are the symptom — do not investigate them individually.

Check whether other nodes are near the same threshold before recommending a reschedule. Moving a
workload onto the next node to fail is not a fix, and on a small cluster the control-plane node
is usually the smallest one.

*Recommended Actions*: raise the requests/limits of the pod that GREW (with the number from
`k8s_recommend_resources`), or reduce what is scheduled onto that node. An eviction is the
symptom; sizing or placement is the fix.
