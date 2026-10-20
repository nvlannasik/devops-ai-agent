# Using the agent in Slack

Mentions come from allowlisted users (`SLACK_ALLOWED_USERS`, see [CONFIGURATION.md](CONFIGURATION.md));
alerts arrive from Alertmanager. Approval-gated fixes have their own page: [REMEDIATION.md](REMEDIATION.md).

## Manual investigation

```
@devops-agent pods in namespace payment-service are crashing with OOMKilled
```

## Follow-up questions

After RCA is posted, follow-up messages are answered conversationally:

```
@devops-agent show me the logs
@devops-agent when did this start?
```

## Cluster tour (onboarding)

```
@devops-agent explain this cluster
@devops-agent jelasin namespace sample-apps
```

An explain/overview/onboarding question about the cluster, a namespace or a workload is a
**tour**: its own tool budget (`TOUR_TOOL_ROUNDS`), the `cluster-tour` skill, and no remediation
card. The data is the MCP server's `k8s_cluster_inventory` — one line per workload for the whole
cluster, or the detail of one namespace (Ingress host → Service → workload, plus what manages it:
Flux HelmRelease/Kustomization, Helm, or nothing). In Slack the facts are **tables built from
that tool result, never from the model**, posted before the model's explanation of what each
workload is for and how it is deployed. The dashboard's `/cluster` page shows the same inventory
as a map.

## Teaching the agent (`learn`)

After an incident is discussed in its alert thread, anyone can teach the agent the
confirmed conclusion:

```
(in the alert thread, after discussing the real cause/fix)
@devops-agent learn
```

The agent extracts `{confirmed root cause, action taken, outcome}` from the thread,
stores it as **human-confirmed** knowledge, and echoes what it learned (mention `learn`
again after correcting the thread if it got it wrong). On the next similar incident the
confirmed knowledge is injected as a strong prior — see [MEMORY.md](MEMORY.md).

Alternatively, react ✅ (`SLACK_LEARN_REACTION`) on any message inside the investigated
thread — same flow, silent outside investigated threads. Needs the `reactions:read`
scope + `reaction_added` event subscription.

## Postmortem draft

In an incident's Slack thread, ask for a write-up (English or Indonesian):

```
@devops-agent postmortem
@devops-agent bikin postmortem
```

The agent assembles one LLM call's narrative (Summary, Impact, Root cause, What went well, What
went poorly, Action items) around a **Timeline and Numbers section rendered entirely from
Postgres data** — the model never writes either, so a hallucinated event or duration can't reach
the document. A human-confirmed root cause (`learn`) outranks the agent's own RCA, and a
disagreement between the two is stated rather than hidden. It posts the Summary and Action items
into the thread plus a link to the full draft, and stores the draft (`postmortems` table,
migration `015`) so it survives on the dashboard at `/incidents/<id>/postmortem`, downloadable as
Markdown at `/incidents/<id>/postmortem.md`. The dashboard never writes one — this is a Slack-only
trigger, and regenerating adds a new row rather than editing the last one. Design:
[`superpowers/specs/2026-10-14-postmortem-draft-design.md`](superpowers/specs/2026-10-14-postmortem-draft-design.md).

## Resolved alerts

When Alertmanager sends `status: resolved` (`send_resolved: true` in the webhook config),
the agent posts "✅ Alert resolved" into the incident thread, records `resolved_at` in the
DB, and releases the dedup claim — so if the alert fires again later it gets a fresh
investigation instead of being suppressed by the 12h dedup TTL.

## Alertmanager integration

```yaml
receivers:
  - name: devops-ai-agent
    webhook_configs:
      - url: http://your-agent:3000/alert
        send_resolved: true   # enables the resolved-alert loop (✅ thread update + dedup release)
        http_config:
          authorization:       # must equal the agent's ALERT_WEBHOOK_TOKEN (omit if unset)
            credentials: <ALERT_WEBHOOK_TOKEN>
route:
  group_by: ["alertname", "namespace"]   # one webhook per group → the agent investigates the group ONCE
  repeat_interval: 12h
  receiver: devops-ai-agent
```

Each webhook the agent receives is one Alertmanager **group** (`group_by`). All alerts in it
share a root cause, so the agent correlates them into **one** thread / investigation /
remediation card — N crashlooping pods no longer spawn N of everything. Correlation across
different alertnames (e.g. a node-down fan-out) is deliberately not attempted. (Correlation
*across groups* — a new alert one call-graph edge from an open incident — is a separate
mechanism, see [INVESTIGATION.md](INVESTIGATION.md#cross-alert-correlation).)

## RCA output (Slack Block Kit)

```
🔴 Critical Severity Incident

📍 Root Cause
Pod payment-api-xxx OOMKilled — memory leak in connection pool.

📊 Evidence
• Pod restarted 15x in 30min — k8s_list_events
• Memory 98% of 512Mi limit — prometheus_query
• OutOfMemoryError in logs — loki_query_range

🚫 Ruled Out
• Network issue — no connection errors found

🔧 Recommended Actions
1. Immediate: Increase memory limit to 1Gi
2. Short-term: Review connection pool
3. Long-term: HPA + resource profiling

⚠️ Impact if Unresolved: Payment outage

📈 Confidence: `High`
```

A **Low** confidence auto-mentions `SLACK_ONCALL_USERS`. Once an RCA is posted the thread's
`markRcaSent` flag keeps follow-ups out of the RCA format.
