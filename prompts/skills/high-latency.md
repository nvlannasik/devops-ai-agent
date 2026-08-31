---
name: high-latency
description: Turning "service Y is slow" into "span Z is slow"
when: latency|slow|timeout|p99|p95
---

1. Batch: prometheus_query (`histogram_quantile(0.99, sum by (service,le) (rate(http_server_request_duration_seconds_bucket{namespace="X"}[5m])))`) + prometheus_query (`histogram_quantile(0.99, sum by (peer,le) (rate(http_client_request_duration_seconds_bucket{namespace="X"}[5m])))`) — server-side P99 says the service is slow, client-side P99 by `peer` says which dependency is making it slow, before you open a single trace
2. tracing_search (`service: "Y", minDurationMs: <near the P99>`) — find concrete slow traces, then tracing_get_trace on the worst one to see WHICH span/downstream is slow (DB, cache, external API). This turns "service Y is slow" into "span Z in service Y is slow".
3. loki_query_range — timeout or connection refused messages around the slow trace's time window
4. k8s_list_pods — check if downstream pods are ready
