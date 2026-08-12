---
name: service-unavailable
description: A Service with no ready backends behind it
when: 503|service unavailable|no endpoints|connection refused
---

1. k8s_get_endpoints (the Service name) — **readyCount = 0 means the Service has NO healthy backend pods** → the direct cause of 503 / connection-refused when the Service exists but routes nowhere
2. k8s_list_pods — ready status + restart counts of the backend pods (why are they not ready?)
3. k8s_list_services + k8s_list_ingresses — confirm the routing config (selector, ports) is intact
4. If backends ARE ready but traffic still fails: k8s_list_network_policies — a deny-all or missing allow rule can silently block traffic
