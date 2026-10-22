# Incident dashboard

Optional read-only web view over the same Postgres the agent writes to. Off by default;
set `DASHBOARD_ENABLED=true` and a `DASHBOARD_PASSWORD` (see [CONFIGURATION.md](CONFIGURATION.md#dashboard)).

```
/                overview — counts, recent incidents, remediation outcomes, model activity + cost per backend
/incidents       filterable list, 10 rows a page
/incidents/N     one incident: the RCA parsed into sections, its remediations & verdicts, LLM usage + cost
/postmortems     every incident with a draft, newest first: requester, backend, revision count (own rail item, under Monitor)
/incidents/N/postmortem      the latest postmortem draft for incident N, rendered (see USAGE.md)
/incidents/N/postmortem.md   the same draft as a raw Markdown download
/topology        the agent stack's own map: LLM backends, MCP tools, Postgres/Redis/SQS stores
/cluster         the cluster inventory as a map: namespaces, then host → Service → workload → managed by
/harness         every gate's activity across recorded runs, LLM latency per backend
/harness/<gate>  one gate's runs; each links to its full trace
/bench           benchmark history (pass rates per scenario and axis)
/context         what the agent sends the model: skill registry + token budget per backend
/prompt          the system prompt this process is holding
/healthz         open (probe target) — everything else needs the session cookie
```

It runs as a **second HTTP listener in the same process** (`DASHBOARD_PORT`, default `3001`),
separate from Slack's port and deliberately not routed by the Ingress — reach it with
`kubectl port-forward`. Auth is one shared password exchanged for a signed cookie; with
`DASHBOARD_PASSWORD` unset every page answers `503` rather than serving anonymous content.
The listener is the one component allowed to fail without stopping the agent: a bad port or a
missing Secret logs and investigations carry on. Design: [`DESIGN_dashboard_auth.md`](DESIGN_dashboard_auth.md).

Everything rendered is treated as untrusted — the RCA text is LLM output — so every
interpolation is escaped and only the two React Flow maps (`/topology`, `/cluster`) are served
with a `script-src` at all — a per-response nonce, never `'unsafe-inline'`.
