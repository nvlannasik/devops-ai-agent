---
name: crashloopbackoff
description: First tool calls for a container restarting in a loop
when: crashloop|restarting|restart count
---

1. k8s_describe_pod — the ground-truth reason: container `state` = "Waiting: CrashLoopBackOff" and `lastState` = "Terminated: <reason> (exit <code>)", plus the pod's `recentEvents`. OOMKilled/exit 137 → memory; exit 1/2 → app error; "Error"/config reasons → misconfig. This tells you which branch to chase before reading logs
2. k8s_get_pod_logs with **`previous: true`** (tail_lines: 200) — the crash message lives in the DEAD container instance, not the fresh restart. Without `previous` you get the new container's (often empty) logs and miss the panic/fatal/OOM line
3. prometheus_query — memory vs limit: `container_memory_working_set_bytes{pod="X"} / container_spec_memory_limit_bytes{pod="X"}`
