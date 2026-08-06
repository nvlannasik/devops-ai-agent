import { test } from "node:test";
import assert from "node:assert/strict";
import { detailPage, listPage, loginPage, overviewPage, errorPage, layout, pageWindow, topologyPage } from "./views.js";
import { PAGE_SIZE, parseFilters } from "./filters.js";
import { STYLES } from "./styles.js";
import type { IncidentDetail, IncidentPage, IncidentRow, Overview, Tokens } from "./queries.js";
import type { Topology } from "./topology.js";

// The shape queries.list() hands the page. The defaults are the ordinary case — one short
// page, counted exactly — so a test that is not about pagination does not have to state a
// total it does not care about.
const page = (rows: IncidentRow[], over: Partial<IncidentPage> = {}): IncidentPage => ({
  rows, hasMore: false, total: rows.length, capped: false, ...over,
});

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
  tokens: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, byBackend: [] },
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
  assert.doesNotThrow(() => listPage(page([]), parseFilters(new URLSearchParams(""))));
  assert.match(listPage(page([]), parseFilters(new URLSearchParams(""))), /no incidents/i);
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
  const html = listPage(page([row], { hasMore: true, total: 140 }), f);
  assert.match(html, /value="KubePodCrashLooping"/);
  assert.match(html, /page=3/);
});

test("listPage's severity select marks \"any\" selected when no severity filter is set", () => {
  const f = parseFilters(new URLSearchParams(""));
  const html = listPage(page([]), f);
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
  const html = listPage(page([nasty]), parseFilters(new URLSearchParams("")));
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
  const html = listPage(page([nasty]), parseFilters(new URLSearchParams("")));
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
  const html = listPage(page([nasty]), parseFilters(new URLSearchParams("")));
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
  assert.doesNotMatch(listPage(page([row]), parseFilters(new URLSearchParams(""))), /<script/);
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
  assert.doesNotMatch(html, /<nav\b|<form class="signout"/);
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

// ---------- overview: figures, cost, and the analysis ----------

const tokens: Tokens = {
  calls: 412,
  input: 1_204_889, output: 88_310, cacheRead: 950_004, cacheCreation: 12_003,
  byBackend: [
    { backend: "private-llm", model: "qwen3-32b", calls: 380, input: 1_100_000, output: 80_000, cacheRead: 0, cacheCreation: 0 },
    { backend: "claude", model: "claude-opus-5", calls: 32, input: 104_889, output: 8_310, cacheRead: 950_004, cacheCreation: 12_003 },
  ],
};

// The hero holds one composed object: the 30-day count set against the series it summarises.
// While the outcome figures shared that frame they read as a caption to the chart, which is
// the thing this split exists to undo — so the assertion is positional, not merely "present".
test("the outcome figures are their own section, outside the hero", () => {
  const html = overviewPage(emptyOverview, []);
  const hero = html.slice(html.indexOf(`class="hero"`), html.indexOf("</section>"));
  assert.match(hero, /class="hero-chart"/, "the chart stays in the hero");
  assert.doesNotMatch(hero, /<dl class="stats">/, "the figures do not");
  assert.ok(
    html.indexOf("</section>") < html.indexOf("<h2>Outcomes</h2>"),
    "Outcomes comes after the hero closes"
  );
  assert.ok(html.indexOf("<h2>Outcomes</h2>") < html.indexOf(`<dl class="stats">`));
});

test("token usage is its own section, in the order volume → outcome → cost", () => {
  const html = overviewPage({ ...emptyOverview, tokens }, []);
  assert.ok(html.indexOf("<h2>Outcomes</h2>") < html.indexOf("<h2>Token usage</h2>"));
  assert.ok(html.indexOf("<h2>Token usage</h2>") < html.indexOf("<h2>Most recurring</h2>"));
});

test("token usage totals the window and breaks it down by backend AND model", () => {
  const html = overviewPage({ ...emptyOverview, tokens }, []);
  assert.match(html, /Total tokens<\/dt><dd>1,293,199/, "input + output, thousands-separated");
  assert.match(html, /Cache reads<\/dt><dd>950,004<span>12,003 written<\/span>/);
  assert.match(html, /LLM calls<\/dt><dd>412/);
  // the model is what the router question is actually about — a heavy backend answering
  // what a light one could have is only visible if the model is on the row
  assert.match(html, /qwen3-32b/);
  assert.match(html, /claude-opus-5/);
  assert.equal([...html.matchAll(/<td class="primary">(?:private-llm|claude)<\/td>/g)].length, 2);
});

// A fresh deployment has an empty llm_usage table, and a zero-row table with five headers
// reads as a broken query rather than a quiet system.
test("token usage names the absence instead of rendering an empty table", () => {
  const html = overviewPage(emptyOverview, []);
  assert.match(html, /No LLM calls recorded in this window/);
  assert.doesNotMatch(html, /<th>Backend<\/th>/);
});

// backend and model come from LLM_BACKEND_<N>_* env vars — the same trust level as every
// other operator-supplied string on the topology page.
test("the token table escapes the backend and model names", () => {
  const html = overviewPage(
    {
      ...emptyOverview,
      tokens: {
        ...tokens,
        byBackend: [{ backend: HOSTILE, model: HOSTILE, calls: 1, input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }],
      },
    },
    []
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// The join between detailPage and rca.ts. rca.test.ts pins the parser; this pins that the
// page actually routes the RCA through it rather than printing the mrkdwn it was given.
test("detailPage renders the RCA as sections, not as a wall of asterisks", () => {
  const rca = [
    "*🔴 Severity:* `Critical`",
    "",
    "*📍 Root Cause*",
    "The memory limit sits below the working set.",
    "",
    "*📊 Evidence*",
    "• Restarted 14 times, reason OOMKilled — _k8s_list_pods_ `prod/api-gateway`",
    "",
    "*🔧 Recommended Actions*",
    "1. *Immediate:* raise the limit to 512Mi",
  ].join("\n");
  const html = detailPage({ incident: { ...row, rca, channel: null, thread_ts: null }, remediations: [], feedback: [] });
  assert.match(html, /<h3 class="rca-head">Root Cause<\/h3>/);
  assert.match(html, /<th>Finding<\/th><th>Source<\/th>/);
  assert.match(html, /<th>Horizon<\/th><th>Action<\/th>/);
  assert.match(html, /<dt>Severity<\/dt>/);
  // and the source markers are gone from the visible text, not merely re-printed
  assert.doesNotMatch(html, /\*📍 Root Cause\*/);
});

test("an incident with no RCA says so rather than rendering an empty analysis", () => {
  const html = detailPage({
    incident: { ...row, rca: "   ", channel: null, thread_ts: null },
    remediations: [], feedback: [],
  });
  assert.match(html, /No analysis recorded/);
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

// ---------- the rail ----------

test("the rail carries every destination as an icon beside a text label", () => {
  const html = layout("Test", "<p>hi</p>");
  assert.match(html, /<header class="rail">/);
  assert.match(html, /<nav aria-label="Primary">/);
  for (const [href, label] of [["/", "Overview"], ["/incidents", "Incidents"], ["/topology", "Topology"]]) {
    assert.match(html, new RegExp(`<a href="${href.replace("/", "\\/")}"[^>]*><svg class="ico"[\\s\\S]*?<span class="lbl">${label}<\\/span>`));
  }
});

// The rail goes icon-only below 30rem by CLIPPING .lbl, not by removing it. That only stays
// accessible while the text is in the markup and the glyph beside it is decorative — an icon
// that announced itself would give the link two names, one of them a drawing.
test("every icon is decorative and every label stays in the markup", () => {
  const html = layout("Test", "<p>hi</p>");
  const icons = [...html.matchAll(/<svg class="ico"[^>]*>/g)];
  assert.equal(icons.length, 4, "three destinations and the sign-out button");
  for (const [tag] of icons) {
    assert.match(tag, /aria-hidden="true"/);
    assert.match(tag, /focusable="false"/, "IE-era focusability still ships in some engines");
  }
  assert.equal([...html.matchAll(/<span class="lbl">/g)].length, 4);
});

test("the rail marks where you are, and marks it once", () => {
  const html = layout("Incidents", "<p>hi</p>", "/incidents");
  assert.match(html, /<a href="\/incidents" aria-current="page">/);
  // matched on the link, not on the bare attribute: the inline stylesheet selects on it too
  assert.equal([...html.matchAll(/<a href="[^"]*" aria-current="page">/g)].length, 1);
  // "/" is the default argument, so a page that forgets to name itself must not light up
  // the Overview link — the reader would be told they are somewhere they are not.
  assert.doesNotMatch(layout("Test", "<p>hi</p>"), /<a href="[^"]*" aria-current/);
});

// The grid is `--rail-w 1fr`; with no rail rendered the first column would still be reserved,
// opening the page 13.5rem short of the left edge. body.bare is what collapses it.
test("a bare page renders no rail and says so on the body", () => {
  const html = loginPage();
  assert.match(html, /<body class="bare">/);
  assert.doesNotMatch(html, /<header class="rail">/);
  assert.match(layout("Test", "<p>hi</p>"), /<body>/, "a signed-in page is not bare");
});

test("the skip link stays first in the document, ahead of the rail", () => {
  const html = layout("Test", "<p>hi</p>");
  assert.ok(html.indexOf(`<a class="skip"`) < html.indexOf(`<header class="rail">`));
});

// The rail put main inside a flex column, and a flex item with an auto cross-axis margin does
// not stretch — it takes fit-content, floored at min-content. On a phone that is the width of
// the widest table, so main grew past the viewport and the whole page scrolled sideways while
// .table-wrap scrolled nothing. min-width alone does not fix it; the definite width does.
test("main and the footer are pinned to the pane rather than to their content", () => {
  for (const sel of ["main", "footer.bottom"]) {
    const rule = STYLES.match(new RegExp(`^${sel} \\{([^}]*)\\}`, "m"));
    assert.ok(rule, `no ${sel} rule to check`);
    assert.match(rule[1], /width: 100%/, `${sel} would take its fit-content width`);
    assert.match(rule[1], /min-width: 0/, `${sel} would be floored at its min-content width`);
  }
});

// ---------- pagination ----------

const filters = (q: string) => parseFilters(new URLSearchParams(q));

test("pageWindow keeps both ends and the neighbours of where you are", () => {
  assert.deepEqual(pageWindow(6, 26), [1, null, 4, 5, 6, 7, 8, null, 26]);
  // nothing to elide: the whole range fits
  assert.deepEqual(pageWindow(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(1, 1), [1]);
});

// An ellipsis standing in for exactly one page costs the same width as the page and hides a
// destination for nothing.
test("pageWindow prints a lone hidden page instead of eliding it", () => {
  // 7 is the only page between the window and the end: printed, not replaced by an ellipsis
  assert.deepEqual(pageWindow(4, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(pageWindow(1, 5), [1, 2, 3, 4, 5]);
  // two hidden pages is where eliding starts to pay for itself
  assert.deepEqual(pageWindow(4, 9), [1, 2, 3, 4, 5, 6, null, 9]);
});

test("the pager numbers the pages and marks the current one as a non-link", () => {
  const html = listPage(page([row], { hasMore: true, total: 140 }), filters("page=2"));
  assert.match(html, /<nav class="pager" aria-label="Pagination">/);
  assert.match(html, /<span class="cur" aria-current="page">2<\/span>/);
  assert.match(html, /<a href="\/incidents" aria-label="Page 1">1<\/a>/);
  assert.match(html, /aria-label="Page 3"/);
});

test("the pager says where in the range you are", () => {
  const rows = Array.from({ length: PAGE_SIZE }, () => row);
  const html = listPage(page(rows, { hasMore: true, total: 140 }), filters("page=2"));
  assert.match(html, /Showing <b>11–20<\/b> of <b>140<\/b> incidents/);
});

// COUNT_CAP stops the count walking the table; past it the number is a floor, and a hard
// "5,000" under a table that keeps producing next pages is a lie the reader cannot check.
test("a capped count renders as a floor, not as an exact total", () => {
  const html = listPage(page([row], { hasMore: true, total: 5000, capped: true }), filters(""));
  assert.match(html, /of <b>5,000\+<\/b> incidents/);
});

test("the arrows carry rel and a name, and a dead one stops being a control", () => {
  const first = listPage(page([row], { hasMore: true, total: 140 }), filters(""));
  assert.match(first, /<span class="step off" aria-hidden="true">←<\/span>/, "no previous page from page 1");
  assert.match(first, /<a class="step" href="[^"]+" rel="next" aria-label="Next page">→<\/a>/);

  const end = listPage(page([row], { hasMore: false, total: 140 }), filters("page=3"));
  assert.match(end, /rel="prev" aria-label="Previous page"/);
  assert.match(end, /<span class="step off" aria-hidden="true">→<\/span>/, "hasMore, not the count, ends the run");
});

// hasMore comes from the over-fetch; the count can be at its ceiling and still not know how
// many pages there are. The arrow has to follow the over-fetch or it goes dark too early.
test("Next stays live past the count's ceiling", () => {
  const html = listPage(page([row], { hasMore: true, total: 5000, capped: true }), filters("page=100"));
  assert.match(html, /rel="next"/);
});

test("one page of rows gets the count and no controls", () => {
  const html = listPage(page([row], { total: 1 }), filters(""));
  assert.match(html, /of <b>1<\/b> incident</, "singular, and no controls to go with it");
  assert.doesNotMatch(html, /<ul class="pages">/);
});

test("no rows means no pager at all", () => {
  assert.doesNotMatch(listPage(page([]), filters("")), /class="pager"/);
});

// Every page link is the current query with one parameter changed. A pager that dropped the
// filters would silently widen the search on the second click.
test("page links carry the filters forward", () => {
  const f = filters("namespace=prod&severity=critical&resolved=false&page=2");
  const html = listPage(page([row], { hasMore: true, total: 400 }), f);
  const next = html.match(/href="([^"]+)" rel="next"/);
  assert.ok(next, "a next link should be present");
  // the href is HTML-escaped in the markup — & is &amp; there, and only there
  const q = new URLSearchParams(next[1].replace(/&amp;/g, "&").split("?")[1]);
  assert.equal(q.get("namespace"), "prod");
  assert.equal(q.get("severity"), "critical");
  assert.equal(q.get("resolved"), "false");
  assert.equal(q.get("page"), "3");
});

// A default restated in a URL is noise the reader has to look past to see which filters are on.
test("page 1 is left out of the link", () => {
  const html = listPage(page([row], { hasMore: true, total: 140 }), filters("page=2"));
  assert.match(html, /<a href="\/incidents" aria-label="Page 1">/);
});

// Paging is not filtering. A per-page control inside the filter form needed Apply to take
// effect and sat nowhere near the pager it governed — that is the shape being ruled out here,
// along with any URL that could widen the LIMIT.
test("nothing about paging lives in the filter form", () => {
  const html = listPage(page([row], { hasMore: true, total: 140 }), filters(""));
  const form = html.match(/<form class="filters"[\s\S]*?<\/form>/)![0];
  assert.doesNotMatch(form, /pageSize|Per page|class="pager"/);
  assert.doesNotMatch(html, /pageSize/, "the size is a constant, not a parameter");
  // and the pager sits under the table, not above it
  assert.ok(html.indexOf(`<table`) < html.indexOf(`<nav class="pager"`));
  assert.ok(html.indexOf(`</form>`) < html.indexOf(`<nav class="pager"`));
});

// The size is what makes the pager visible at all: a 50-row page turns the common case into
// one long scroll with a summary line at the bottom and no controls anywhere.
test("a page holds ten rows", () => {
  assert.equal(PAGE_SIZE, 10);
  const html = listPage(page(Array.from({ length: PAGE_SIZE }, () => row), { hasMore: true, total: 25 }), filters(""));
  assert.equal([...html.matchAll(/<td class="primary"><a href="\/incidents\//g)].length, PAGE_SIZE);
  assert.match(html, /aria-label="Page 3"/, "25 incidents at ten a page is three pages");
});

// Two different absences: page 1 matched nothing, page 7 outlived the rows it pointed at.
// The way out of the second is a link, not a suggestion to widen the filter.
test("an out-of-range page offers the way back instead of blaming the filters", () => {
  const html = listPage(page([], { total: 12 }), filters("namespace=prod&page=7"));
  assert.match(html, /<strong>Nothing on page 7\.<\/strong>/);
  assert.match(html, /matches 12 incidents/);
  assert.match(html, /<a href="\/incidents\?namespace=prod">Go to the first page<\/a>/);
  assert.doesNotMatch(html, /Widen the date range/);
});
