---
name: node-pressure
description: A node under memory, disk or PID pressure — the pod that dies is rarely the pod that caused it
when: memorypressure|diskpressure|pidpressure|node ?(is ?)?not ?ready|node\b[^\n]{0,40}\bis not ready|nodenotready|evicted|eviction|kubelet|node pressure|node\.kubernetes\.io/unreachable|node (is )?unreachable|disk full|node down
---

The eviction victim is chosen by QoS and overage, not by blame. A `BestEffort` pod with no
requests dies first even when the memory was taken by something else entirely. **Never name the
evicted pod as the cause** — find what actually grew.

1. `k8s_describe_node` — `conditions` (MemoryPressure / DiskPressure / PIDPressure / Ready),
   `taints`, and capacity vs allocatable. The condition's own message says which resource and by
   how much.
2. `k8s_node_pods` for that node — every pod on it with QoS, requests/limits and LIVE working set
   (busiest first), the node's real memory and root-disk usage, and what the scheduler promised
   (`allocated`). The top consumer and the evicted pod are usually different pods; name both, and
   say which is which. Requests are promises and working set is usage — a node can be 40%
   requested and 95% used.
   **When the node's memory usage is well above the pods' total working set, the gap is memory
   outside Kubernetes** — etcd (a systemd service on these control-plane nodes, not a pod),
   kubelet, containerd, the OS. No pod listing shows it. Call `node_host_snapshot` for the node:
   it lists the largest processes with `where` (a `.service` unit or `pod`) and memory per systemd
   service, with `available`, `anonymous` and swap. Name the process and its unit with its number;
   never say "something outside the pods". If the tool answers that no devops-vm-agent reports for
   the node, say the gap is unexplained and that host-level data is missing there.
3. `k8s_list_events` with `since_minutes: 60` — `Evicted`, `SystemOOM`, `FailedScheduling`. The
   eviction event names the threshold that was crossed.
4. `k8s_recommend_resources` for the top consumer — an eviction loop is a sizing fault most of
   the time, and this gives the number to change rather than "reduce memory usage".

**An eviction that names the POD's own limit is not node pressure.** "ephemeral local storage usage
exceeds the total limit of containers" means that pod went over its own `ephemeral-storage` limit:
the pod is the cause, the node is fine, and a cordon or drain fixes nothing.

**A control-plane node under pressure is a capacity problem.** `kube-apiserver-<node>`,
`kube-controller-manager-<node>` and `kube-scheduler-<node>` are static pods from the kubelet's
manifests, and etcd is either another (`etcd-<node>`) or a systemd service (`etcd.service`, seen
only in `node_host_snapshot`) — never propose resizing any of them (a memory limit on the API
server or etcd makes it the OOM victim), never propose restarting etcd, and never cordon or drain
the node. Name what uses the memory, and recommend more memory for that machine or moving workload
pods off it.

**`Ready: Unknown` is not pressure.** It means the kubelet stopped reporting: the node may be
fine and unreachable, or down. Its pods will sit `Terminating` until the node returns. That is a
node/network incident and the pods are the symptom — do not investigate them individually.

Check whether other nodes are near the same threshold before recommending a reschedule. Moving a
workload onto the next node to fail is not a fix, and on a small cluster the control-plane node
is usually the smallest one.

*Recommended Actions*: raise the requests/limits of the pod that GREW (with the number from
`k8s_recommend_resources`), or reduce what is scheduled onto that node. An eviction is the
symptom; sizing or placement is the fix.
