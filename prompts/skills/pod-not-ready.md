---
name: pod-not-ready
description: A running container that never passes its readiness probe
when: not ?ready|readiness|probe fail
---

1. k8s_describe_pod — `conditions` (Ready / ContainersReady) + each container's `state`; a failing probe shows as a not-ready container even while Running
2. k8s_list_events — look for "Readiness probe failed" with the actual response
3. k8s_get_pod_logs — what was the application doing when the probe failed?
4. State the container's **restartCount** in the answer, and rule a crash out by it. *Not ready* and *crashing* are different faults with different fixes, and the restart count is the one number that separates them: a container that has never restarted is running fine and failing its probe — the probe or its target is wrong, not the process. Saying "CrashLoopBackOff" here is wrong about a fact `kubectl get pods` prints in its first column.
