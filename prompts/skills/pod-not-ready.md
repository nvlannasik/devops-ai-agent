---
name: pod-not-ready
description: A running container that never passes its readiness probe
when: not ?ready|readiness|probe fail
---

1. k8s_describe_pod — `conditions` (Ready / ContainersReady) + each container's `state`; a failing probe shows as a not-ready container even while Running
2. k8s_list_events — look for "Readiness probe failed" with the actual response
3. k8s_get_pod_logs — what was the application doing when the probe failed?
