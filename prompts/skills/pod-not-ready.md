---
name: pod-not-ready
description: A running container that never passes its readiness probe
when: not ?ready|readiness|probe fail
---

1. k8s_describe_pod — `conditions` (Ready / ContainersReady) + each container's `state`; a failing probe shows as a not-ready container even while Running
2. k8s_list_events — look for "Readiness probe failed", and read what it actually says: the HTTP path, the port, and the status or error it came back with. **Name that target in the answer.** "The readiness probe is failing" is the alert restated; `GET /healthz on port 8080 returns 404` is a finding, and it is the difference between a human knowing where to look and not.
3. k8s_get_pod_logs — what was the application doing when the probe failed?
4. State the container's **restartCount** in the answer, and rule a crash out by it. *Not ready* and *crashing* are different faults with different fixes, and the restart count is the one number that separates them: a container that has never restarted is running fine and failing its probe — the probe or its target is wrong, not the process. Saying "CrashLoopBackOff" here is wrong about a fact `kubectl get pods` prints in its first column.
5. If the probe's target is wrong — a path the app does not serve, a port nothing listens on — the fault is in the spec, and no restart reaches it. Say which of the two it is: the probe is pointed at the wrong thing, or the app really is not ready yet.
