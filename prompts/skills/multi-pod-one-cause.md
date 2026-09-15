---
name: multi-pod-one-cause
description: More than one pod broken at once — settle whether it is one cause or many before writing anything
when: pods are|multiple pods|several pods|all pods|both pods|[0-9]+ pods|semua pod|beberapa pod|banyak pod|group|grouped
---

When MORE than one pod is failing, the first question is not "why is this pod broken" — it is
**"is this one fault or several?"** Answer it before investigating any single pod, because the
two answers produce completely different write-ups from the same evidence.

1. `k8s_correlate_pods` with the namespace. Omit `pods` to take every not-ready pod — it is the
   natural follow-up to `k8s_cluster_health`. It diffs the broken pods against the HEALTHY ones
   and returns what the broken set shares that no healthy pod has.
2. Read **`uniqueToBroken` first**. `sharedWithHealthy` is mostly noise: pods of one Deployment
   share nearly everything, and none of it explains the failure.
3. A shared attribute is a **lead, not a cause**. Confirm it with its own call — the ConfigMap
   with `k8s_list_configmaps` or `k8s_get_resource`, the node with `k8s_describe_node`, the image
   with the workload listing — then say which call confirmed it.
4. **Empty `uniqueToBroken` is an answer, not a dead end.** It says a single shared cause is
   unlikely inside the pod spec. Look outside it: node pressure, a recent deploy, an upstream
   dependency. Say that is what you concluded and why.
5. `healthyCompared: 0` means there was no control group, so nothing could be singled out — with
   every pod broken, every shared attribute looks unique. Say the comparison was not possible
   rather than presenting the shared list as a finding.

**In the RCA, state the verdict explicitly in the TL;DR**: "all 8 pods in `ns/workload` share one
cause" or "these are 3 separate faults". An on-call reading eight pod names needs to know whether
that is one page or three before reading anything else. Name the shared thing exactly — the env
variable, the ConfigMap key, the node — never "a configuration issue".
