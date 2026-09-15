---
name: pod-terminating
description: A pod that will not finish deleting — five causes, and one field tells them apart
when: terminating|stuck deleting|won'?t delete|not deleting|finalizer|force delete|grace period|stuck terminating|tidak terhapus|nyangkut
---

`Terminating` is not one fault. It is five, and `k8s_describe_pod` returns the three fields that
separate them: `deletionTimestamp`, `terminationGracePeriodSeconds`, `finalizers`.

1. `k8s_describe_pod` — read those three FIRST, before anything else.
2. **Has the grace period even elapsed?** `now - deletionTimestamp` < `terminationGracePeriodSeconds`
   means nothing is wrong yet: the container is still being asked to stop. Say so and stop —
   a normal shutdown reported as an incident costs more than it saves.
3. **`finalizers` non-empty → the name tells you the owner.** `kubernetes.io/pv-protection` or a
   CSI attacher (`external-attacher/...`) is the storage layer; `foregroundDeletion` is the
   garbage collector waiting on children; anything else names the controller holding it. Read
   that controller's own object with `k8s_get_custom_resources` or `k8s_get_resource` and say
   what it is waiting for. **The finalizer's name is the root cause statement** — quote it.
4. **`finalizers` EMPTY → the pod is not being blocked.** Check the node with
   `k8s_describe_node`: a `NotReady` or unreachable node leaves its pods Terminating until the
   node recovers or the pod is force-deleted, and that is a node incident, not a pod one.
5. Still unexplained → `k8s_list_events` with `field_selector: "involvedObject.name=<pod>"`.
   `FailedKillPod`, `Multi-Attach error` and unmount failures show up here and nowhere else.

**Do not assume the storage layer.** A cluster with a CSI driver makes volume-detach the easiest
guess and it is wrong most of the time — steps 2 and 4 rule it out with one field each, before
any storage tool is called.

*Recommended Actions*: name the blocking controller and what it waits for. Force deletion
(`--grace-period=0 --force`) is **not** a fix and is not something you can execute — it abandons
the resource the finalizer protects, which is how a volume ends up attached to a node that no
longer has the pod. Say that plainly if someone asks for it.
