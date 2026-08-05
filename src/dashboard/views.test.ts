import { test } from "node:test";
import assert from "node:assert/strict";
import { detailPage, listPage, loginPage, overviewPage, errorPage, layout, topologyPage } from "./views.js";
import { parseFilters } from "./filters.js";
import type { IncidentDetail, IncidentRow, Overview } from "./queries.js";
import type { Topology } from "./topology.js";

// Stands in for the per-response value server.ts mints. Fixed here so a test can assert the
// nonce reached the markup; the real one is 16 random bytes and never repeats.
const NONCE = "test-nonce";

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
  inbound: [], outbound: [], provider: "router", backends: [], capabilities: [], registryError: null,
};

test("nodeRows escapes label, detail, and meta on the topology page", () => {
  const t: Topology = {
    ...baseTopology,
    inbound: [{ label: HOSTILE, detail: HOSTILE, meta: HOSTILE, configured: true }],
  };
  const html = topologyPage(t, NONCE);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("nodeRows escapes the non-router activeClient row too", () => {
  const t: Topology = {
    ...baseTopology,
    provider: "claude",
    activeClient: { label: HOSTILE, detail: HOSTILE, meta: HOSTILE, configured: true },
  };
  const html = topologyPage(t, NONCE);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// A fully-wired agent: every group the diagram can link into is populated, so a link that
// points at nothing has somewhere to be missing from.
const wiredTopology: Topology = {
  ...baseTopology,
  inbound: [{ label: "Slack", detail: "channel C1", meta: "bot token set", configured: true }],
  outbound: [
    { label: "Postgres", detail: "pg:5432/db", meta: "ssl disable", configured: true },
    { id: "llm-worker", label: "llm-worker (SQS)", detail: "req -> res", meta: "region x", configured: true },
    { id: "devops-mcp-server", label: "devops-mcp-server", detail: "stdio", meta: "stdio", configured: true },
  ],
  backends: [
    { name: "direct1", kind: "claude", model: "m", endpoint: "https://x", route: "heavy", viaWorker: false },
    { name: "worker1", kind: "private-llm", model: "m", endpoint: "sqs", route: "light", viaWorker: true },
  ],
  capabilities: [
    { name: "k8s", tools: [
      { name: "k8s_list_pods", write: false },
      { name: "k8s_restart_deployment", write: true },
    ] },
    { name: "loki", tools: [{ name: "loki_query", write: false }] },
  ],
};

// The contract between topology-svg.ts (which draws the links) and views.ts (which renders the
// rows they point at). Both derive the anchor from the same array position through rowId(), and
// nothing else on the page would break if they drifted — the links would just silently stop
// going anywhere. Asserted over the whole document, in both directions the reader can travel.
test("every link in the diagram lands on a row that exists on the page", () => {
  const html = topologyPage(wiredTopology, NONCE);
  const targets = new Set([...html.matchAll(/<tr id="([\w-]+)"/g)].map((m) => m[1]));
  // the diagram's own links, not every anchor on the page — the skip link points at <main>
  const hrefs = [...html.matchAll(/<a href="#([\w-]+)" class="topo-link"/g)].map((m) => m[1]);

  assert.ok(hrefs.length >= 8, "each box in the diagram should link to its row");
  for (const h of hrefs) assert.ok(targets.has(h), `#${h} is linked but no row carries that id`);
  // and the numbering is per group, not per rendered cluster
  assert.ok(targets.has("backend-1"), "the second backend should keep its own row id");
  assert.ok(targets.has("cap-1"), "the second tool family should keep its own row id");
});

// The count answers "how much can this agent see"; the names answer "what, exactly". Both are
// on the page — the names behind a <details> so a thirty-tool family cannot bury the counts.
test("each family lists its own tools, and marks the ones that can change the cluster", () => {
  const html = topologyPage(wiredTopology, NONCE);
  assert.match(html, /<details><summary><span class="mono" translate="no">k8s<\/span><\/summary>/);
  assert.match(html, />k8s_list_pods</);
  assert.match(html, />loki_query</);
  // the write marker sits on the tool it belongs to, not merely somewhere in the row
  assert.match(html, /k8s_restart_deployment\s*<span class="badge" data-tone="warning">write<\/span>/);
  assert.doesNotMatch(html, /k8s_list_pods\s*<span class="badge"[^>]*>write<\/span>/);
});

// The floor the interactive layer stands on. topology-script.ts removes these radios at run
// time, so nothing on the rendered page proves they still work — this test is the only thing
// that keeps them from being quietly deleted along the way. Scripting off, or the nonce'd
// block blocked, and this is the whole zoom control.
test("the diagram scales and expands without a line of JavaScript", () => {
  const html = topologyPage(wiredTopology, NONCE);
  // Inline handlers and javascript: URLs stay forbidden even now that a script is allowed:
  // a nonce covers a <script> block and nothing else, so either would be dead markup that
  // only looks like it works. The one permitted script is asserted on its own below.
  assert.doesNotMatch(html, /onclick=|javascript:/i);
  // the radios must PRECEDE the view: the scale rules are `:checked ~ .topo-view`
  const firstRadio = html.indexOf(`<input type="radio" name="topo-zoom"`);
  assert.ok(firstRadio > 0, "the zoom control should render");
  assert.ok(firstRadio < html.indexOf(`class="topo-view"`), "the radios must be siblings before the view");
  assert.match(html, /id="topo-z1"[^>]*checked/, "fit is the state the page opens in");
  assert.equal([...html.matchAll(/<label for="topo-z\d"/g)].length, 3);
  // progressive disclosure is still script-free: <details> is the only widget that works
  // under a policy with no script-src at all, which is what every other page here has
  assert.match(html, /<details><summary>/);
});

// The interactive layer, and the exactness the nonce demands: one block, carrying the value
// the response's own header named. A second <script> would be one the header does not cover.
test("the topology page carries exactly one script, and it is the nonce'd one", () => {
  const html = topologyPage(wiredTopology, NONCE);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)];
  assert.equal(scripts.length, 1, "one script, no more");
  assert.equal(scripts[0][0], `<script nonce="${NONCE}">`, "no src, no type, just the nonce");
  // after the frame it enhances: it runs at parse time, so the toolbar replaces the radio bar
  // before either is painted rather than flashing one and then the other
  assert.ok(html.indexOf("<script") > html.indexOf(`class="topo-view"`), "the script follows its markup");
  assert.doesNotMatch(html, /<script[^>]*src=/, "nothing is fetched: the page stays self-contained");
});

test("the live toolbar ships hidden, labelled, and complete", () => {
  const html = topologyPage(wiredTopology, NONCE);
  // Rendered server-side but display:none until the script sets data-live — so it is markup a
  // reader without JavaScript never sees, rather than three buttons that do nothing.
  assert.match(html, /<div class="topo-tools">/);
  assert.match(html, /<button type="button" data-zoom="out" aria-label="Zoom out">/);
  assert.match(html, /<button type="button" data-zoom="in" aria-label="Zoom in">/);
  assert.match(html, /<button type="button" data-zoom="reset">Reset<\/button>/);
  // the readout starts where the map does; the script rewrites it on every change
  assert.match(html, /<span class="topo-level"[^>]*>100%<\/span>/);
  // the glyphs carry no meaning to a screen reader, which is what the aria-labels are for
  assert.doesNotMatch(html, /aria-label="[+−]"/);
});

// The rest of the dashboard gets no script-src at all (see csp() in server.ts). A script that
// leaked into layout() would be inert there — and a silent, permanent bug on every page.
test("no page but topology carries a script", () => {
  assert.doesNotMatch(layout("Test", "<p>hi</p>"), /<script/);
  assert.doesNotMatch(overviewPage(emptyOverview, [row]), /<script/);
  assert.doesNotMatch(listPage([row], parseFilters(new URLSearchParams("")), false), /<script/);
  assert.doesNotMatch(loginPage(), /<script/);
  assert.doesNotMatch(errorPage("Nope", "no"), /<script/);
});

// ---------- sign-in ----------

test("the sign-in page asks for one thing and offers no way around it", () => {
  const html = loginPage();
  assert.match(html, /<form method="post" action="\/login"/);
  assert.match(html, /<input id="password" name="password" type="password"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /<label for="password">/, "the field is labelled, not placeholder-only");
  // Nothing to navigate to and no session to end: the nav and the Sign out button would
  // both be controls that cannot do anything from here. Matched as markup — the prose of
  // the inline stylesheet mentions both by name.
  assert.doesNotMatch(html, /<nav>|<form class="signout"/);
  assert.doesNotMatch(html, /<script|onclick=|javascript:/i);
});

test("a sign-in error names the next move and not which half was wrong", () => {
  const html = loginPage({ error: "That password is not right. Check it and try again." });
  assert.match(html, /<p class="formerror" role="alert">/, "a screen reader must be told, not just shown");
  assert.match(html, /That password is not right/);
});

test("the page carries `next` forward, escaped, and drops a useless one", () => {
  const html = loginPage({ next: `/incidents?q=a"b` });
  assert.match(html, /<input type="hidden" name="next" value="\/incidents\?q=a&quot;b">/);
  // "/" is where an empty next lands anyway — a hidden field saying so is markup that
  // exists to restate the default.
  assert.doesNotMatch(loginPage({ next: "/" }), /name="next"/);
  assert.doesNotMatch(loginPage(), /name="next"/);
});

test("signed-in pages offer a way out, and the footer no longer claims there is no lock", () => {
  const html = layout("Test", "<p>hi</p>");
  assert.match(html, /<form class="signout" method="post" action="\/logout">/);
  // GET would let any page anywhere sign an operator out by linking an image at it.
  assert.doesNotMatch(html, /<a[^>]+href="\/logout"/);
  assert.doesNotMatch(html, /No authentication/i);
  assert.match(html, /This session ends after \d+ hours/);
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
  const html = topologyPage(t, NONCE);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
