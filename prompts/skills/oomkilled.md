---
name: oomkilled
description: First tool calls for a container killed at its memory limit
when: oomkill|out of memory|exit code 137|memory limit
---

1. k8s_describe_pod — confirm `lastState` = "Terminated: OOMKilled (exit 137)" and read the container's configured memory **limit** (the `resources` field) — the kill happens at that limit
2. prometheus_query_range — memory trend: `container_memory_working_set_bytes{namespace="X",pod=~"service.*"}` (look for steady climb toward the limit)
3. k8s_get_pod_logs with `previous: true` — check for memory leak indicators in the killed instance before the kill
