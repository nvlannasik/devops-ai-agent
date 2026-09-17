---
name: healthy-but-failing
description: The service that paged looks fine — the work one hop away is not happening
when: upstream|downstream|dependency|peer|queue|not draining|backlog|unprocessed|never settled|stopped answering|target ?down|cannot scrape|stale
---

The thing that pages is not always the thing that is broken, and in this class it usually is not. Every probe passes, every pod is Ready, the dashboard is green — and orders are accepted and never settled, or a call to a peer times out, or a process stays up and stops serving. **Do not close this because the workload is healthy.** Healthy is the finding, not the reassurance.

1. **Name the hop.** `http_client_requests_total{service,peer,status}` carries `timeout` and `error` as literal `status` values beside the numeric codes — that is what turns "service A is failing" into "A's call to B is timing out", and B is where to look next. The service that fired the alert is the caller, not the cause.
2. A queue that is not draining has a **consumer**, and the consumer is the subject. Find it, then read its logs — a worker that serves no HTTP traffic will never move an error-rate counter, so Prometheus staying quiet about it means nothing at all. `loki_query_range` over the worker, not the API.
3. State the **age of the oldest unprocessed item** and the point it stopped moving. A backlog is a number and a time; "the queue is backing up" is the alert restated.
4. A scrape target that stopped answering while its pod stays Running is the same shape: the process is alive and no longer serving. Check the port and the endpoint before the pod — `k8s_get_endpoints` shows whether it left the Service, and a restart is not the fix for a process that never crashed.
5. Blast radius is the question this class actually turns on: who is downstream of the thing that stopped, and are they failing yet or just about to? Say which, by name.
