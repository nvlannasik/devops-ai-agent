---
name: rollout-stuck
description: A deployment whose new ReplicaSet never becomes ready
when: rollout|progressdeadline|replicas ?mismatch|not progressing
---

1. k8s_get_rollout_status — desired vs updated/ready/available; `complete: false` + a condition like Progressing=False `ProgressDeadlineExceeded` confirms a stalled rollout
2. k8s_list_replicasets — the new RS vs the old one; if the new RS has 0 ready, its pods are failing → k8s_describe_pod one of them for the reason
3. k8s_list_events — image pull / quota / scheduling errors on the new pods
