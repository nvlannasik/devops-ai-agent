---
name: log-alert
description: An alert that fired FROM logs — the evidence is the log line, and no metric will show it
when: source=loki|log spike|error log|unhandled route|logging errors|panic|traceback|stack ?trace|exception
---

This alert came from the **Loki Ruler**, not from Prometheus. `source=loki` in the alert's labels is
what says so. That changes where the investigation starts, and it changes what "nothing found" means.

**A metric alert tells you a number moved and leaves you to find out why. A log alert already holds
the evidence** — a rule matched actual log lines, and those lines name the route, the exception and
the stack. Do not open with `k8s_list_pods` and work inwards. Go to the logs the rule matched, first
call, and only reach for the cluster once you know what the application actually said.

1. **`loki_query_range` on the lines the rule matched**, over a window that starts ~15 minutes before
   `Firing since`. The rules in this cluster group by `namespace, service, pod`, all of which the
   alert carries, so you can reconstruct the query from the alert itself:
   - error-log spike → `{namespace="<ns>", app="<service>"} | json | level = "error"`
   - unhandled route errors → `{namespace="<ns>", app="<service>"} | json | msg = "unhandled route error"`
   - The alert's `service` label and the `app` stream label carry the same value for these
     workloads, so put it in `app` inside `{...}` — that is the indexed one. `service` itself is a
     **JSON field**, so if you ever need it directly it goes after `| json`, never in the selector.
   - Query by `app`, not by `pod`. The alert names the pod that was logging when it fired; by the
     time you look, a restart or a rollout may have replaced it, and `{pod="..."}` then returns
     nothing — which reads as "no errors" when the errors are still happening under a new name.
2. **Read the lines and name the actual error.** The whole point of this alert is that the message,
   the route and the exception exist and a counter cannot show them. An RCA for a log alert that
   never quotes a log line has not used its own evidence. Quote the real line; do not paraphrase it
   into "errors were observed".
3. **Then check whether the workload is otherwise healthy** — `k8s_list_pods` for the namespace, and
   `k8s_describe_pod` on the named pod. This is the branch point:
   - pods restarting / not ready → the log errors are a *symptom*, and the pod failure is the story.
     Switch to the crashloop or pod-not-ready playbook.
   - **pods perfectly healthy → this is the case log alerting exists for.** A service can serve 500s,
     or fail every batch it picks up, while every probe passes and every pod stays Ready. Say that
     plainly. Do not report "pods are healthy" as if it were reassurance; here it is the finding.
4. **Correlate with the metric side, but do not require it.** `prometheus_query` on the error rate for
   the same service either confirms the same event from the other side, or shows nothing — and
   nothing is *expected* for a workload that serves no HTTP traffic (a worker, a consumer, a cron).
   The absence of a metric is not the absence of a fault. Never close a log alert as a false positive
   because Prometheus is quiet.
5. **Recent change?** `k8s_list_deployments` / `k8s_list_replicasets` — if the errors start at a
   rollout, the image is the lead.

**Remediation reality check.** A log alert usually means the application is broken, not the cluster:
a bad code path, a bad config value, a dependency it cannot reach. A rolling restart clears a stuck
process and nothing else — if the log says "invalid config key" or "connection refused to
postgres:5432", say so and name the real fix (the config, the dependency, a rollback to the last
working image). Do not propose a restart just because it is the action available.
