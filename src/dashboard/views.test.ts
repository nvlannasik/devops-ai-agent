import { test } from "node:test";
import assert from "node:assert/strict";
import { detailPage, listPage, overviewPage, errorPage, layout, topologyPage } from "./views.js";
import { parseFilters } from "./filters.js";
import type { IncidentDetail, IncidentRow, Overview } from "./queries.js";
import type { Topology } from "./topology.js";

const row: IncidentRow = {
  id: 1, created_at: new Date("2026-07-28T23:48:00Z"), resolved_at: null,
  alertname: "KubernetesContainerOomKiller", namespace: "metallb-system",
  severity: "warning", confidence: "high", root_cause: "container hit its memory limit",
};
const emptyOverview: Overview = {
  weekly: [], recurring: [], totalIncidents: 0, resolvedIncidents: 0,
  remediationSucceeded: 0, remediationFailed: 0, feedback: {},
};

test("layout emits a complete, self-contained document with inline styles", () => {
  const html = layout("Test", "<p>hi</p>");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>/);
  // no build step and no CDN: every asset must be inline or the page breaks
  assert.doesNotMatch(html, /<script src=|<link[^>]+href="http/);
});

// The whole point of phase 1 is that a fresh deployment is the normal first experience.
test("every page renders on empty data without throwing", () => {
  assert.doesNotThrow(() => overviewPage(emptyOverview, []));
  assert.doesNotThrow(() => listPage([], parseFilters(new URLSearchParams("")), false));
  assert.match(listPage([], parseFilters(new URLSearchParams("")), false), /no incidents/i);
});

// THE security test at the render layer. rca is LLM output.
test("detailPage escapes the RCA instead of emitting it as markup", () => {
  const incident: IncidentDetail = {
    ...row, rca: `<img src=x onerror="alert(1)">`, channel: "C1", thread_ts: "1785282508.001",
  };
  const html = detailPage({ incident, remediations: [], feedback: [] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("detailPage escapes the alert labels too", () => {
  const incident: IncidentDetail = {
    ...row, alertname: `<b>X</b>`, rca: "fine", channel: null, thread_ts: null,
  };
  assert.doesNotMatch(detailPage({ incident, remediations: [], feedback: [] }), /<b>X<\/b>/);
});

// The dashboard complements Slack rather than replacing it; the link is the join.
test("detailPage links back to the Slack thread when it knows one", () => {
  const incident: IncidentDetail = { ...row, rca: "x", channel: "C123", thread_ts: "1785282508.001" };
  assert.match(
    detailPage({ incident, remediations: [], feedback: [] }),
    /slack\.com\/app_redirect\?channel=C123&amp;message_ts=1785282508\.001/
  );
});

test("detailPage omits the Slack link when the incident has no thread", () => {
  const incident: IncidentDetail = { ...row, rca: "x", channel: null, thread_ts: null };
  assert.doesNotMatch(detailPage({ incident, remediations: [], feedback: [] }), /app_redirect/);
});

// URL-construction defect, not attribute breakout: esc() alone HTML-escapes the whole
// URL string but never URL-encodes the components, so a raw "&" or "#" from Slack
// survives into the href, the browser un-escapes "&amp;" back to "&" at click time, and
// the value grows a second live query parameter (or a fragment) that "wins" over ours.
test("detailPage URL-encodes channel/thread_ts so an embedded & cannot inject a second query parameter", () => {
  const incident: IncidentDetail = {
    ...row, rca: "x", channel: "C123", thread_ts: "1785282508.001&channel=EVILCHAN",
  };
  const html = detailPage({ incident, remediations: [], feedback: [] });
  assert.doesNotMatch(html, /channel=EVILCHAN/);
  assert.match(html, /message_ts=1785282508\.001%26channel%3DEVILCHAN/);
});

test("detailPage URL-encodes channel/thread_ts so an embedded # cannot inject a fragment", () => {
  const incident: IncidentDetail = {
    ...row, rca: "x", channel: "C123", thread_ts: "1785282508.001#evil",
  };
  const html = detailPage({ incident, remediations: [], feedback: [] });
  assert.doesNotMatch(html, /message_ts=1785282508\.001#evil/);
  assert.match(html, /message_ts=1785282508\.001%23evil/);
});

test("listPage keeps the active filters in the form and in the pager link", () => {
  const f = parseFilters(new URLSearchParams("alertname=KubePodCrashLooping&page=2"));
  const html = listPage([row], f, true);
  assert.match(html, /value="KubePodCrashLooping"/);
  assert.match(html, /page=3/);
});

test("listPage's severity select marks \"any\" selected when no severity filter is set", () => {
  const f = parseFilters(new URLSearchParams(""));
  const html = listPage([], f, false);
  const severityBlock = html.match(/<select name="severity">([\s\S]*?)<\/select>/);
  assert.ok(severityBlock, "severity select should be present");
  assert.match(severityBlock![1], /<option value="" selected>any<\/option>/);
});

test("errorPage states the problem without leaking a stack trace", () => {
  const html = errorPage("Database unavailable", "connection refused");
  assert.match(html, /Database unavailable/);
  assert.match(html, /connection refused/);
});

// The four interpolation sites that had no test. Each of these was mutation-checked: remove
// the esc() it guards and this test goes red. Without them, escaping was pinned only on
// detailPage's rca/alertname — while incidentTable, which renders on BOTH / and /incidents
// and carries root_cause (LLM output, named as such by the spec), was unguarded.
const HOSTILE = `<img src=x onerror="alert(1)">`;

test("incidentTable escapes alertname and root_cause on the list page", () => {
  const nasty: IncidentRow = { ...row, alertname: HOSTILE, root_cause: HOSTILE };
  const html = listPage([nasty], parseFilters(new URLSearchParams("")), false);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("incidentTable escapes on the overview page too, not just the list", () => {
  const nasty: IncidentRow = { ...row, alertname: HOSTILE, root_cause: HOSTILE };
  const html = overviewPage(emptyOverview, [nasty]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("the severity pill escapes its label", () => {
  const nasty: IncidentRow = { ...row, severity: HOSTILE };
  const html = listPage([nasty], parseFilters(new URLSearchParams("")), false);
  assert.doesNotMatch(html, /<img src=x/);
});

test("the remediation status pill and its params JSON are escaped", () => {
  const incident: IncidentDetail = { ...row, rca: "fine", channel: null, thread_ts: null };
  const html = detailPage({
    incident,
    remediations: [
      {
        action: "k8s_set_image",
        params: { workload: HOSTILE },
        status: HOSTILE,
        approved_by: null,
        result: null,
        created_at: new Date("2026-07-28T23:48:00Z"),
        executed_at: null,
      },
    ],
    feedback: [],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// node-postgres returns BIGSERIAL as a string, so IncidentRow.id being typed `number` is not
// a runtime guarantee — the same reasoning that made esc(p.value) a finding in svg.ts.
test("the incident link escapes its id rather than trusting the number type", () => {
  const nasty = { ...row, id: `1"><script>alert(1)</script>` as unknown as number };
  const html = listPage([nasty], parseFilters(new URLSearchParams("")), false);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

// topologyPage's own review found nodeRows() and backendRows() had no escaping coverage —
// the secret-leak test in topology.test.ts proves sentinels don't leak, but its sentinels
// are plain SENTINEL-* strings with no HTML-breaking characters, so it says nothing about
// escaping. label/detail/meta and name/kind/model/route/endpoint carry
// LLM_BACKEND_<N>_NAME/_MODEL, the Slack channel id, hostnames and queue names onto an
// unauthenticated page — exactly as untrusted as everything else HOSTILE already covers.
// Putting HOSTILE in every field of one row means removing esc() from ANY one of them
// leaves it raw in the output and fails doesNotMatch, regardless of which field it was —
// each was independently mutation-checked (see task-2-report.md's "Fix section").
const baseTopology: Topology = {
  inbound: [], outbound: [], provider: "router", backends: [], registryError: null,
};

test("nodeRows escapes label, detail, and meta on the topology page", () => {
  const t: Topology = {
    ...baseTopology,
    inbound: [{ label: HOSTILE, detail: HOSTILE, meta: HOSTILE, configured: true }],
  };
  const html = topologyPage(t);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("nodeRows escapes the non-router activeClient row too", () => {
  const t: Topology = {
    ...baseTopology,
    provider: "claude",
    activeClient: { label: HOSTILE, detail: HOSTILE, meta: HOSTILE, configured: true },
  };
  const html = topologyPage(t);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("backendRows escapes name, kind, model, route, and endpoint", () => {
  const t: Topology = {
    ...baseTopology,
    backends: [
      {
        name: HOSTILE, kind: HOSTILE as unknown as Topology["backends"][number]["kind"],
        model: HOSTILE, endpoint: HOSTILE,
        route: HOSTILE as unknown as Topology["backends"][number]["route"],
        viaWorker: false,
      },
    ],
  };
  const html = topologyPage(t);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
