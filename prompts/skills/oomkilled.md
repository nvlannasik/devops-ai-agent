---
name: oomkilled
description: First tool calls for a container killed at its memory limit
when: oomkill|out of memory|exit code 137|memory limit
---

1. k8s_describe_pod — confirm `lastState` = "Terminated: OOMKilled (exit 137)" and read the container's configured memory **limit** (the `resources` field) — the kill happens at that limit
2. prometheus_query_range — memory trend: `container_memory_working_set_bytes{namespace="X",pod=~"service.*"}` (look for steady climb toward the limit)
3. k8s_get_pod_logs with `previous: true` — check for memory leak indicators in the killed instance before the kill
4. **State both numbers in the answer: the configured limit, and the working set the container actually reached.** The remediation is a number, and it cannot be written from "it ran out of memory" — a proposal needs a limit to set. An RCA that names neither leaves a human to go and read the same two fields.
5. Those two numbers also decide WHICH fix. A working set that climbs steadily to the limit and is killed, over and over, is a **leak**: a bigger limit buys time and does not repair it, and the answer should say so rather than only proposing a number. A working set that sits flat just under a limit set too low is a **sizing** fault, and raising the limit IS the fix. A restart is neither — the fresh pod is built from the same spec and meets the same limit, usually within minutes.
