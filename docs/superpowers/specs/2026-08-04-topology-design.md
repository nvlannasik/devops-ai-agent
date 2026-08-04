# Design — Dependency Map (dashboard phase 2a)

**Date:** 2026-08-04
**Status:** design agreed. Nothing implemented yet.
**Scope:** `devops-ai-agent` only — one new page on the existing dashboard. No new dependency, no
new RBAC, no new environment variable, no outbound call.
**Builds on:** `2026-08-03-dashboard-design.md` (the dashboard itself, its safety rails, and its
no-authentication posture, all of which apply unchanged here).

## 1. Problem

This system is three repositories, and what connects them is written down in three different
`CLAUDE.md` files plus a HelmRelease. Answering "what is this agent actually wired to, and over
what" today means reading all of them and holding the result in your head.

The agent already knows the answer. Every dependency it has is declared in its own config —
the MCP endpoint, the database, the cache, three SQS queues, the LLM backends and their routes,
the Slack channel, the alert webhook. Nothing reads that back and shows it.

## 2. Scope

**In:** one page, `/topology`, rendering the agent's declared dependencies as a diagram plus a
table. Read from `config` at render time. No calls out.

**Explicitly out, and why:**

- **Live health per edge.** Colouring each edge by whether the dependency is reachable needs
  probes that do not exist, and they would run on the event loop that also handles alerts. It is
  a coherent next step, not part of this one.
- **Cluster discovery.** Scanning the cluster for services answers a different question ("what is
  running") from the one this page answers ("what is this agent connected to"). It needs
  cross-namespace read RBAC the agent does not have, and it duplicates the `k8s_*` MCP tools.
- **Anything about `llm-worker`'s or `devops-mcp-server`'s own dependencies.** This page shows one
  agent's view. A whole-system map would need those services to report their own config, which is
  a protocol, not a page.

## 3. The safety property this page turns on

**Rendering is allowlist-only. Never a denylist.**

This page's input is the config object, and that object holds `DB_PASSWORD`, `SLACK_BOT_TOKEN`,
`MCP_AUTH_TOKEN`, `ALERT_WEBHOOK_TOKEN`, `REDIS_PASSWORD` and every `LLM_BACKEND_<N>_KEY`. The
dashboard has no authentication (`2026-08-03-dashboard-design.md` §3.1), so anything this page
renders is readable by anything that can reach the port.

The page therefore builds an explicit list of the fields it emits, field by field. It never
iterates the config object, and it never filters a known-bad set out of one. A denylist is wrong
here for a structural reason: it is correct only until someone adds the next secret, and the
failure is silent — the new field simply appears on the page.

**Endpoints are redacted before rendering.** A base URL may legitimately carry credentials
(`https://user:pass@host/v1`). Host and port are shown; userinfo is stripped; query strings are
dropped. An unparseable URL renders as `(unparseable)` rather than raw.

**A test asserts the whole rendered page contains no configured secret value.** Not a review
convention — a test that seeds every secret-bearing config field with a recognisable sentinel and
fails if any appears in the output. That is what makes the allowlist hold as the config grows.

## 4. What it renders

### 4.1 Groups

Inbound — things that call the agent:

| Node | Shown from |
|---|---|
| Slack | `config.slack.alertChannel`, whether Socket Mode is configured |
| Alertmanager | the `/alert` path, and whether a webhook token is set (**set / not set**, never the value) |

Outbound — things the agent calls:

| Node | Shown from |
|---|---|
| `devops-mcp-server` | transport (`http` / `stdio`), redacted URL, whether an auth token is set |
| Postgres | host, port, database name, SSL mode |
| Redis | host, port, db index, TLS on/off |
| `llm-worker` (SQS) | request / response / DLQ queue names, region, timeout |
| GitOps remediation (SQS) | queue name, timeout, enabled or not |
| LLM backends | per backend: name, kind, model, redacted base URL, and which route it is on |

### 4.2 The router is the interesting part

When `LLM_PROVIDER=router`, the page shows each registered backend, its kind, and whether it sits
on the heavy chain, the light chain, or neither. It also draws the consequence that is easy to
miss from reading config: **only backends of kind `private-llm` traverse SQS to `llm-worker`;
`claude` and `openai-compatible` backends are called directly from the agent.** That single fact
is the most common wrong assumption about this system, and the diagram is where it becomes obvious.

For the other three providers the page shows the one active client and says so.

### 4.3 Diagram

Hand-laid-out inline SVG, generated server-side, in the shape the existing `svg.ts` already
establishes: a fixed arrangement, not a graph-layout algorithm. The node count is bounded and
known — one agent, two inbound, five outbound groups, and up to twenty backends — so a layout
engine would be a dependency bought to solve a problem this page does not have.

Below the diagram, a table per group carries the detail. The table is the accessible
representation; the diagram is the glance. Both come from the same data structure, so they cannot
disagree.

## 5. Structure

| File | Responsibility |
|---|---|
| `src/dashboard/topology.ts` | `buildTopology(): Topology` — config → a plain data structure. Pure apart from reading config. Holds the allowlist. |
| `src/dashboard/topology.test.ts` | The secret-leak test (§3), the router/provider branches, redaction |
| `src/dashboard/views.ts` | `topologyPage(t: Topology): string` — diagram + tables |
| `src/dashboard/server.ts` | Route `/topology`, and a nav link |

`buildTopology()` returns data, never HTML. That split is what lets the leak test assert against
the structure *and* the rendered page, and what keeps the redaction testable without parsing HTML.

## 6. Error handling

The page must render with any config, including a half-configured one. A missing optional
dependency renders as "not configured" rather than being omitted — an absent row is
indistinguishable from a forgotten one. `buildTopology()` cannot throw; a malformed value renders
as its own placeholder.

It reads no database, so it works when Postgres is down. That makes it the one page that is
useful *while* something is broken, which is when someone is most likely to open it.

## 7. Testing

Pure functions, as everywhere else in this dashboard:

- **The secret-leak test** (§3) — the load-bearing one
- Redaction: userinfo stripped, query dropped, unparseable input handled
- The router branch: backends split correctly across heavy / light / unrouted, and the
  `private-llm`-goes-via-SQS distinction rendered
- The non-router branches: each provider shows its one client
- A half-configured agent renders "not configured", not a blank or a crash
- The rendered page escapes everything, per the existing `esc()` contract

## 8. Deferred

- Live health per edge — needs probes (§2)
- The other two services' own dependency maps — needs a protocol, not a page
- Export (Mermaid / Graphviz) — trivial to add once the data structure exists, worth nothing until
  someone asks
