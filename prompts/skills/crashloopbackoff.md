---
name: crashloopbackoff
description: First tool calls for a container restarting in a loop
when: crashloop|restarting|restart count
---

1. k8s_describe_pod — the ground-truth reason: container `state` = "Waiting: CrashLoopBackOff" and `lastState` = "Terminated: <reason> (exit <code>)", plus the pod's `recentEvents`. OOMKilled/exit 137 → memory; exit 1/2 → app error; "Error"/config reasons → misconfig. This tells you which branch to chase before reading logs
2. k8s_get_pod_logs with **`previous: true`** (tail_lines: 200) — the crash message lives in the DEAD container instance, not the fresh restart. Without `previous` you get the new container's (often empty) logs and miss the panic/fatal/OOM line
3. **`unable to retrieve container logs for containerd://…` is not the end of the evidence — go to Loki.** The kubelet serves a dead instance's logs from a file on the node, and the runtime deletes that file when it garbage-collects the container; a pod that has been looping for a while has usually lost several instances this way. The line itself is not gone — it was shipped as it was printed. Query `loki_query_range` with `{namespace="<ns>", app="<workload>"}` over the last 30-60 minutes and read the crash from there. Do this before reporting the logs as unavailable: "the kubelet could not serve it" and "nothing recorded it" are different statements, and only the first one is true here
4. prometheus_query — memory vs limit: `container_memory_working_set_bytes{pod="X"} / container_spec_memory_limit_bytes{pod="X"}`
5. **State the exit code and the line that caused it, verbatim.** A container that exits 1 and one that is OOMKilled at 128Mi are two incidents, and "CrashLoopBackOff" names neither — it is the symptom Kubernetes prints, not a finding. Quote the decisive log line from the DEAD instance as it was written. If the previous-instance fetch came back empty AND Loki has nothing either, say that instead of inferring the reason from the exit code alone.
