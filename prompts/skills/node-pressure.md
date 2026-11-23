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
   the node, say the gap is unexplained and that host-level data is missing there. Then
   `node_host_history` for the same node says what GREW: quote its `systemdServicesThatMoved` /
   `processesThatMoved` (start → end, change) — a leak and a steady load look the same in one snapshot.
   `node_journal` with `kubelet.service` (`minutes: 30`) shows the eviction manager's own lines —
   which signal it acted on and what it evicted; quote the line, do not paraphrase it.
3. `k8s_list_events` with `since_minutes: 60` — `Evicted`, `SystemOOM`, `FailedScheduling`. The
   eviction event names the threshold that was crossed.
4. `k8s_recommend_resources` for the top consumer — an eviction loop is a sizing fault most of
   the time, and this gives the number to change rather than "reduce memory usage".

**An eviction that names the POD's own limit is not node pressure.** "ephemeral local storage usage
exceeds the total limit of containers" means that pod went over its own `ephemeral-storage` limit:
the pod is the cause, the node is fine, and a cordon or drain fixes nothing.

**MemoryPressure has two triggers — say which one fired.** The kubelet raises it when the HOST is
within its hard threshold (`memory.available`, usually 100Mi) OR when PODS are within that
threshold of the node's `allocatable` memory. The second fires with hundreds of Mi still free on
the host: compare `usage.memoryAvailable` with the sum of the pods' `memoryWorkingSet` against
`allocatable.memory` from `k8s_node_pods`. Free memory on the host + pods near allocatable = the
pod-allocatable signal, and the fix is placement or reservation sizing, not "something leaked".
Allocatable is capacity minus `kubeReserved` + `systemReserved` + the eviction threshold.

**A control-plane node under pressure is a capacity problem.** `kube-apiserver-<node>`,
`kube-controller-manager-<node>` and `kube-scheduler-<node>` are static pods from the kubelet's
manifests, and etcd is either another (`etcd-<node>`) or a systemd service (`etcd.service`, seen
only in `node_host_snapshot`) — never propose resizing any of them (a memory limit on the API
server or etcd makes it the OOM victim), never propose restarting etcd, and **never cordon or drain
a control-plane node, not even as an "Immediate" line or a runbook step**: its pods are the control
plane itself, a cordon frees no memory, and the agent refuses the action anyway. Name what uses
the memory, and recommend more memory for that machine. Call `control_plane_balance` too: when
the pressured master holds most leader roles (the API VIP sends it all outside traffic) or serves
the most watches, say so with its numbers — that is why THIS master runs short first.

On a small HA control plane the load is NOT even across the masters, and it moves:
- Only the **leader** of `kube-controller-manager` and `kube-scheduler` does the work and holds the
  caches (~2x the memory of a follower). The holders are the Leases `kube-system/kube-controller-manager`,
  `kube-system/kube-scheduler`, and `plndr-cp-lock` for the kube-vip VIP — read them with
  `k8s_get_resource` (`api_version: coordination.k8s.io/v1`, `kind: Lease`, `namespace: kube-system`).
  A master that holds several of them is the heavy one, and pressure follows the leases when they
  move: the master under pressure today may be a different one tomorrow, with no change at all.
- **kube-apiserver** memory grows with its long-lived watch connections, which stay on whichever
  API server they first reached. The longest-running API server collects the clients of the others
  each time one restarts. A large gap in `kube-apiserver-<node>` working set between masters of the
  same size points here, not to a leak.
So compare the node under pressure with its peer control planes before naming a cause: the same
pods using more memory on one master is placement (leases, connections), not growth.

*Recommended Actions for a control-plane node*: more memory for that machine (the lasting fix);
check that `kubeReserved` + `systemReserved` match what really runs outside pods there (oversized
reservations shrink allocatable and trigger the pod-allocatable signal early); and, for an uneven
API server, the kube-apiserver flag `--goaway-chance` (e.g. 0.001) that spreads clients over the
API servers. Never restart, resize, cordon or drain anything of the control plane as the fix.

**`Ready: Unknown` is not pressure.** It means the kubelet stopped reporting: the node may be
fine and unreachable, or down. Its pods will sit `Terminating` until the node returns. That is a
node/network incident and the pods are the symptom — do not investigate them individually.

Check whether other nodes are near the same threshold before recommending a reschedule. Moving a
workload onto the next node to fail is not a fix, and on a small cluster the control-plane node
is usually the smallest one.

*Recommended Actions*: raise the requests/limits of the pod that GREW (with the number from
`k8s_recommend_resources`), or reduce what is scheduled onto that node. An eviction is the
symptom; sizing or placement is the fix.
