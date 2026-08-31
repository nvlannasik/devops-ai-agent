---
name: high-error-rate
description: Correlating a 5xx spike with a deploy
when: 5xx|error rate|http_?5|internal server error
---

1. Batch: prometheus_query (`sum by (service) (rate(http_server_requests_total{namespace="X",status=~"5.."}[5m]))`) + k8s_list_events
   — then `sum by (service,peer,status) (rate(http_client_requests_total{namespace="X",status=~"5..|timeout|error"}[5m]))`: a 5xx a service SERVES is often a call it MAKES failing, and `peer` names which one. `status` carries `timeout` and `error` literally.
2. loki_query_range — errors with context: `{namespace="X", app="Y"} |= "error" | json`
3. Correlate: when did the error spike start? Cross-check with recent k8s_list_deployments changes
