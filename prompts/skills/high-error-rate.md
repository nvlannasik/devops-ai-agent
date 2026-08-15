---
name: high-error-rate
description: Correlating a 5xx spike with a deploy
when: 5xx|error rate|http_?5|internal server error
---

1. Batch: prometheus_query (`sum(rate(http_requests_total{status=~"5..",namespace="X"}[5m])) by (service)`) + k8s_list_events
2. loki_query_range — errors with context: `{namespace="X", app="Y"} |= "error" | json`
3. Correlate: when did the error spike start? Cross-check with recent k8s_list_deployments changes
