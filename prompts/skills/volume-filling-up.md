---
name: volume-filling-up
description: A bound PersistentVolume running out of space — how full, how fast, and who writes it
when: fillingup|filling up|no space left|disk full|[0-9.]+% free|volume remains|kubelet_volume_stats|volume[^\n]{0,20}(full|usage)
---

A claim that is filling up is BOUND and working: this is a space fault, not a binding one, and
pvc-pending does not apply.

1. `prometheus_query` — how full, as numbers: `kubelet_volume_stats_used_bytes{namespace="<ns>",
   persistentvolumeclaim="<pvc>"}` against `kubelet_volume_stats_capacity_bytes` for the same claim.
   State it as `9.1Gi of 10Gi (91%)`, never as "almost full".
2. `prometheus_query_range` on `kubelet_volume_stats_available_bytes` over 24h — the SHAPE is the
   finding. A steady climb gives a time-to-full (`predict_linear(...[6h], 24*3600) < 0` means it
   fills within a day); a single step means one event wrote it all. Say which, and when it hits zero.
3. **Who writes it.** `k8s_list_pvcs` for the claim, then the pod that mounts it (`k8s_describe_pod`
   shows `claimName`), then that pod's logs for what grows. On Postgres it is commonly WAL that is
   never recycled or tables that are never vacuumed; elsewhere, logs or a cache on the data path.
4. `no space left on device` in a log means it is ALREADY full and writes are failing now — a
   database there refuses commits until space is freed. Say which it is: approaching, or full.
5. `k8s_list_storageclasses` — `allowVolumeExpansion: true` on the claim's class means it can grow
   in place (Longhorn supports it); `false` means growing it is a migration. Name which.

*Recommended Actions*: the size is the claim's `resources.requests.storage` — on a Flux-managed
chart a PR to the value that sets it, never a live edit, and there is no approval-card action for
storage: say so and name the number. Deleting data is never the Immediate — name what grows and let
a human decide what can go.
