import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { detailPage, listPage, loginPage, overviewPage, errorPage, layout, pageWindow, promptPage, REFRESH_SECONDS, topologyPage, contextPage, skillPage } from "./views.js";
import { PAGE_SIZE, parseFilters } from "./filters.js";
import { matchRoute } from "./server.js";
import { STYLES } from "./styles.js";
import type { IncidentDetail, IncidentPage, IncidentRow, Overview, RemediationRow, Tokens } from "./queries.js";
import type { Topology } from "./topology.js";
import type { ContextView } from "./context.js";

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
  range: "30d", seriesUnit: "per day",
  weekly: [], recurring: [], totalIncidents: 0, resolvedIncidents: 0,
  mttrMs: null, severity: [],
  remediationSucceeded: 0, remediationFailed: 0, verdicts: {}, verdictsPending: 0, feedback: {},
  tokens: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, byBackend: [] },
  prev: { totalIncidents: 0, openIncidents: 0, mttrMs: null, feedbackTotal: 0 },
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
  // not anchored to `<tr `: a row that opts into a narrow layout carries role="row" first.
  const targets = new Set([...html.matchAll(/<tr[^>]* id="([\w-]+)"/g)].map((m) => m[1]));
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

// Three tables on this page opt into a narrow layout and a fourth deliberately does not, and
// which is which is decided by what the cells hold: a dependency row is three phrases and takes
// the stack, a backend row is five short identifiers and takes the pairs, a family and its count
// are two words that fit any screen and take neither. Getting this wrong is invisible on a
// desktop — the page only comes apart at 390px, where nothing here runs.
test("each topology table takes the narrow layout its own cells call for", () => {
  const html = topologyPage(wiredTopology, NONCE);

  assert.equal([...html.matchAll(/<table role="table" data-stack>/g)].length, 2, "inbound and outbound");
  const pairs = [...html.matchAll(/<table role="table" data-stack data-pairs>([\s\S]*?)<\/table>/g)];
  assert.equal(pairs.length, 1, "the backend table, and only it");
  assert.doesNotMatch(html, /<table role="table" data-pairs/, "pairs without stack never stacks");

  // The opt-out, asserted rather than assumed: stacking this one would put the expanded tool
  // list between a family and the count it belongs to.
  assert.match(
    html,
    /<table class="caps"><thead><tr><th>Family<\/th>/,
    "the capability table stays a table at every width"
  );

  for (const t of html.matchAll(/<table role="table" data-stack(?: data-pairs)?>([\s\S]*?)<\/table>/g)) {
    const heads = [...t[1].matchAll(/<th role="columnheader">([^<]*)<\/th>/g)].map((m) => m[1]);
    const labels = [...t[1].matchAll(/<td role="cell"[^>]*data-label="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(labels.length % heads.length, 0, "a row is missing a captioned cell");
    for (const l of labels) assert.ok(heads.includes(l), `caption ${l} names no column of this table`);
  }
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

// Where a section heading starts. These assertions are about the ORDER of the sections, so
// they must not also pin the heading's internal markup — a glyph moving in or out of the
// caption is not a change to the page's sequence, and matching on `<h2>Token usage</h2>` made
// every one of them fail for that reason.
const sectionAt = (html: string, title: string): number => {
  const at = html.indexOf(`${title}</span></h2>`);
  assert.notEqual(at, -1, `no section heading named ${title}`);
  return at;
};

// The state panel is the first thing on the page and the hero follows it: the question that can
// be urgent ("how many are still open") is answered in the first line, not under a chart. The
// assertion is positional because "present somewhere" is exactly what it was before the move.
test("the state panel opens the page, above the hero", () => {
  const html = overviewPage(emptyOverview, []);
  const panel = html.indexOf(`<dl class="stats">`);
  const hero = html.indexOf(`class="hero"`);
  assert.ok(panel !== -1 && hero !== -1);
  assert.ok(panel < hero, "the figures come first");
  assert.ok(html.indexOf(`<h1 class="eyebrow"`) < panel, "and the page's title labels them");
  // The hero keeps one composed object and nothing else. While the figures shared its frame
  // they read as a caption to the chart, which is the thing this split exists to undo.
  const heroHtml = html.slice(hero, html.indexOf("</section>", hero));
  assert.match(heroHtml, /class="hero-chart"/, "the chart stays in the hero");
  assert.doesNotMatch(heroHtml, /<dl class="stats">/, "the figures do not");
});

// Four figures, one shelf, four columns — the grid is a fixed 4 → 2 → 1 ladder, so a fifth
// figure would wrap alone onto a second row and read as a category of its own.
//
// The sub-line rule is the other half of the same layout contract: a stat's value is anchored to
// the FLOOR of its tile, which is what keeps a row of figures on one line when the captions wrap
// differently — but it anchors the sub-line with it, so a shelf that gives three figures a
// sub-line and the fourth none puts that fourth value a line above its neighbours.
// Matches the variants too (`stats facts`): a variant changes how a stacked tile lays out, not
// what a shelf is allowed to hold.
// The opening tag is KEPT in each slice: the variant is on the class, and a caller has to be
// able to tell a four-wide shelf from the two-wide `pair` that lives inside a panel.
const shelvesOf = (html: string): string[] =>
  [...html.matchAll(/<dl class="stats[^"]*">[\s\S]*?<\/dl>/g)].map((m) => m[0]);

test("every stat shelf holds four figures, and a shelf's sub-lines are all or none", () => {
  const pages = [
    overviewPage({ ...emptyOverview, tokens }, []),
    detailPage({ incident: { ...row, rca: null, channel: null, thread_ts: null }, remediations: [], feedback: [] }),
  ];
  const shelves = pages.flatMap(shelvesOf);
  assert.equal(
    shelves.length, 4,
    "the state panel, the outcomes pair, the token totals, the incident fact bar"
  );
  for (const shelf of shelves) {
    const stats = shelf.split(`<div class="stat"`).slice(1);
    // Four, or the two-wide `pair` variant that lives inside a panel. Never three and never
    // five: the ladder only ever halves, so anything else orphans a tile on a row of its own.
    const pair = shelf.startsWith(`<dl class="stats pair">`);
    assert.equal(stats.length, pair ? 2 : 4, shelf.slice(0, 40));
    const withSub = stats.filter((s) => s.includes("<span>")).length;
    assert.ok(
      withSub === 0 || withSub === stats.length,
      `shelf mixes ${withSub} sub-lines into ${stats.length} figures`
    );
  }
});

// Open incidents are the one figure on the page that can be bad news, and the only one that
// carries a tone. A tone on every tile is a tone on none.
test("open incidents wear the severity spine, and only while any are open", () => {
  // Scoped to the shelf: the stylesheet is inlined into every page and names the tones too.
  const shelf = (html: string): string =>
    html.slice(html.indexOf(`<dl class="stats">`), html.indexOf("</dl>"));

  const busy = shelf(overviewPage({ ...emptyOverview, totalIncidents: 10, resolvedIncidents: 7 }, []));
  assert.match(busy, /<div class="stat" data-tone="critical" data-linked><dt>[\s\S]*?>Open<\/span>[\s\S]*?<dd>3/);
  assert.equal(busy.match(/data-tone=/g)?.length, 1, "nothing else on the shelf is toned");

  const quiet = shelf(overviewPage({ ...emptyOverview, totalIncidents: 10, resolvedIncidents: 10 }, []));
  assert.match(quiet, /<div class="stat" data-linked><dt>[\s\S]*?>Open<\/span>[\s\S]*?<dd>0/, "no tone when nothing is open");
  assert.doesNotMatch(quiet, /data-tone=/);
});

test("token usage is its own section, in the order state → volume → cost", () => {
  const html = overviewPage({ ...emptyOverview, tokens }, []);
  assert.ok(html.indexOf(`class="hero"`) < sectionAt(html, "Token usage"));
  assert.ok(sectionAt(html, "Token usage") < sectionAt(html, "Most recurring"));
});

test("token usage totals the window and breaks it down by backend AND model", () => {
  const html = overviewPage({ ...emptyOverview, tokens }, []);
  // The call count rides in the sub-line rather than taking a fifth tile — it is the
  // denominator of the total above it, not a fourth kind of token.
  assert.match(
    html,
    /Total tokens<\/span><\/dt><dd>1,293,199<span>input \+ output over 412 calls<\/span>/,
    "input + output, thousands-separated, over the call count"
  );
  assert.match(html, /Cache reads<\/span><\/dt><dd>950,004<span>12,003 written<\/span>/);
  // the model is what the router question is actually about — a heavy backend answering
  // what a light one could have is only visible if the model is on the row
  assert.match(html, /qwen3-32b/);
  assert.match(html, /claude-opus-5/);
  assert.equal(
    [...html.matchAll(/data-label="Backend">(?:private-llm|claude)<\/td>/g)].length,
    2
  );
});

// A fresh deployment has an empty llm_usage table, and a zero-row table with five headers
// reads as a broken query rather than a quiet system.
test("token usage names the absence instead of rendering an empty table", () => {
  const html = overviewPage(emptyOverview, []);
  assert.match(html, /No LLM calls recorded in this window/);
  assert.doesNotMatch(html, /Backend<\/th>/);
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
  assert.match(html, /<th role="columnheader">Finding<\/th><th role="columnheader">Source<\/th>/);
  assert.match(html, /<th role="columnheader">Horizon<\/th><th role="columnheader">Action<\/th>/);
  assert.match(html, /<dt>Severity<\/dt>/);
  // and the source markers are gone from the visible text, not merely re-printed
  assert.doesNotMatch(html, /\*📍 Root Cause\*/);
});

// The stacked layout captions each cell from its own data-label, so the caption and the column
// header are two copies of one string in two places. Nothing else notices when they drift: the
// page keeps rendering, the desktop header stays right, and the phone quietly labels Result
// with "Approved by". Every stacked cell must carry a label, and every label must be a header.
test("a stacked table's captions are its headers", () => {
  const html = detailPage({
    incident: { ...row, rca: null, channel: null, thread_ts: null },
    remediations: [{
      id: 1, action: "k8s_scale", params: { replicas: 3 }, status: "succeeded",
      approved_by: "U1", result: "applied", executed_at: new Date("2026-07-28T23:50:00Z"),
    } as RemediationRow],
    feedback: [{
      slack_user: "anna", confirmed_root_cause: "limit too low", action_taken: "raised it",
      outcome: "resolved", created_at: new Date("2026-07-28T23:55:00Z"),
    } as FeedbackRow],
  });

  // Both variants, because the invariant is the same one: a caption comes from the cell's own
  // data-label, so the only thing that can make it wrong is naming a column the table lacks.
  for (const t of html.matchAll(/<table role="table" data-stack(?: data-pairs)?>([\s\S]*?)<\/table>/g)) {
    const heads = [...t[1].matchAll(/<th role="columnheader">([^<]*)<\/th>/g)].map((m) => m[1]);
    const labels = [...t[1].matchAll(/<td role="cell"[^>]*data-label="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(heads.length > 0, "a stacked table with no headers has nothing to caption from");
    assert.equal(labels.length % heads.length, 0, "a row is missing a captioned cell");
    for (const l of labels) assert.ok(heads.includes(l), `caption ${l} names no column of this table`);
  }
  // both tables opted in — a five-column record is the case this exists for
  assert.equal([...html.matchAll(/<table role="table" data-stack>/g)].length, 2);
});

// `pairs` is the stack with the caption moved beside the value, so it must carry BOTH attributes:
// the stylesheet's stack block does the work and the pairs block only overrides two declarations.
// Emitting `data-pairs` alone would silently leave a table that never stacks at all.
test("a table of short values is a stack with its captions beside them", () => {
  const html = overviewPage(
    {
      ...emptyOverview,
      tokens,
      recurring: [
        { alertname: "KubePodCrashLooping", namespace: "prod", n: 23, last_seen: new Date("2026-07-28T21:30:00Z") },
      ],
    },
    []
  );
  const pairs = [...html.matchAll(/<table role="table" data-stack data-pairs>([\s\S]*?)<\/table>/g)];
  assert.equal(pairs.length, 2, "token usage and most recurring");
  assert.doesNotMatch(html, /<table role="table" data-pairs/, "pairs without stack never stacks");

  // Same caption/header rule as the plain stack — the two tables differ in where the caption
  // sits, never in where it comes from.
  for (const t of pairs) {
    const heads = [...t[1].matchAll(/<th role="columnheader">([^<]*)<\/th>/g)].map((m) => m[1]);
    const labels = [...t[1].matchAll(/<td role="cell"[^>]*data-label="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(labels.length % heads.length, 0, "a row is missing a captioned cell");
    for (const l of labels) assert.ok(heads.includes(l), `caption ${l} names no column of this table`);
  }
  // The alert name is the longest string on the page and takes the same wrap points the
  // incident list gives it — the hanging indent leaves it a narrower column than the table did.
  // The name is a link into the list filtered to it, so the wrap points sit inside the anchor.
  assert.match(html, /data-label="Alert"><a href="[^"]*">Kube<wbr>Pod<wbr>Crash<wbr>Looping</);
});

// Severity and Confidence arrive as sections; rendered as sections they spend a heading and a
// full-width panel each on one word. rca.ts promotes the one-line ones onto the field strip,
// and the stylesheet only styles a strip — so if the promotion stops happening the page still
// renders, just three screens tall on a phone. Pinned from the page, not the parser, because
// this is the join the reader sees.
test("a one-line verdict is a field, an argued one keeps its section", () => {
  const terse = detailPage({
    incident: { ...row, rca: "*Root Cause*\nThe limit is too low.\n\n*Severity*\ncritical\n\n*Confidence*\nhigh — the exit code agrees.", channel: null, thread_ts: null },
    remediations: [], feedback: [],
  });
  assert.match(terse, /class="rca-fields verdicts"/);
  assert.match(terse, /<dt>Severity<\/dt><dd>critical<\/dd>/);
  assert.doesNotMatch(terse, /<h3 class="rca-head">Severity<\/h3>/);

  const argued = detailPage({
    incident: { ...row, rca: "*Root Cause*\nThe limit is too low.\n\n*Severity*\ncritical\n\n*Confidence*\n• the exit code says OOMKilled\n• the memory series agrees", channel: null, thread_ts: null },
    remediations: [], feedback: [],
  });
  assert.match(argued, /<h3 class="rca-head">Confidence<\/h3>/, "two bullets are an argument, and an argument keeps its panel");
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

// The stylesheet is inlined into every page and names every class the markup does, so a
// doesNotMatch against the whole document is always satisfied by the CSS. Everything below
// asserts against the BODY.
const bodyOf = (html: string): string => html.split("</style>")[1] ?? "";


test("the rail carries every destination as an icon beside a text label", () => {
  const html = layout("Test", "<p>hi</p>");
  assert.match(html, /<header class="rail">/);
  assert.match(html, /<nav aria-label="Primary">/);
  for (const [href, label] of [["/", "Overview"], ["/incidents", "Incidents"], ["/topology", "Topology"], ["/context", "Context"]]) {
    assert.match(html, new RegExp(`<a href="${href.replace("/", "\\/")}"[^>]*><svg class="ico"[\\s\\S]*?<span class="lbl">${label}<\\/span>`));
  }
});

// The rail goes icon-only below 30rem by CLIPPING .lbl, not by removing it. That only stays
// accessible while the text is in the markup and the glyph beside it is decorative — an icon
// that announced itself would give the link two names, one of them a drawing.
test("every icon is decorative and every label stays in the markup", () => {
  const html = layout("Test", "<p>hi</p>");
  const icons = [...html.matchAll(/<svg class="ico"[^>]*>/g)];
  assert.equal(
    icons.length, 8,
    "the drawer's two states, the brand mark, four destinations and the sign-out button"
  );
  for (const [tag] of icons) {
    assert.match(tag, /aria-hidden="true"/);
    assert.match(tag, /focusable="false"/, "IE-era focusability still ships in some engines");
  }
  assert.equal([...html.matchAll(/<span class="lbl">/g)].length, 5);
});

// ---------- section glyphs ----------

// Every page's headings, so a glyph added to one page and forgotten on another fails here.
const everyPage = (): [string, string][] => [
  ["overview", overviewPage({ ...emptyOverview, tokens }, [row])],
  ["detail", detailPage({ incident: { ...row, rca: "x", channel: "C1", thread_ts: "1.0" }, remediations: [], feedback: [] })],
  ["topology", topologyPage(baseTopology, NONCE)],
  ["context", contextPage(CTX)],
  ["skill", skillPage(CTX.skills[1]!)],
];

// h2's own gap is the distance out to the hairline. Reusing it between a glyph and the word
// the glyph labels put 16px there and the two stopped reading as one thing — so the pair is
// wrapped in .sec and it is the wrapper, not the icon, that h2 spaces. A heading that puts
// the icon back as a direct child of h2 renders with that gap and passes every other test.
test("every section heading pairs its glyph with its label inside one flex item", () => {
  for (const [page, html] of everyPage()) {
    const headings = [...html.matchAll(/<h2>[\s\S]*?<\/h2>/g)].map(([h]) => h);
    assert.ok(headings.length > 0, `${page} has no section headings`);
    for (const h of headings) {
      assert.match(h, /^<h2><span class="sec"><svg class="ico"[\s\S]*?<\/svg>[^<]+<\/span>/, `${page}: ${h}`);
    }
  }
});

// Same contract as the rail's icons, enforced across every glyph the dashboard now draws:
// decorative, and no colour of its own. Both matter for a different reason — an icon that
// announced itself would give a heading two names, and a hard-coded fill would spend colour
// on decoration when colour is reserved here for severity, focus, and where you are.
test("every glyph on every page is decorative and inherits its colour", () => {
  for (const [page, html] of everyPage()) {
    const icons = [...html.matchAll(/<svg class="ico"[^>]*>/g)].map(([t]) => t);
    assert.ok(icons.length > 4, `${page} draws only the rail's icons`);
    for (const tag of icons) {
      assert.match(tag, /aria-hidden="true"/, `${page}: ${tag}`);
      assert.match(tag, /focusable="false"/, `${page}: ${tag}`);
      assert.match(tag, /stroke="currentColor"/, `${page}: ${tag}`);
      assert.doesNotMatch(tag, /fill="(?!none)/, `${page}: a glyph must not carry its own colour`);
    }
  }
});

// A stat's icon is markup and its label is text, and they are concatenated into the same <dt>.
// Escaping the icon would print the SVG source; not escaping the label would make every stat
// an injection site the day one is built from a row instead of a literal.
test("a stat renders its glyph as markup and its label as text", () => {
  const html = overviewPage({ ...emptyOverview, tokens }, []);
  assert.match(
    html,
    /<dt><span class="kpi-icon" aria-hidden="true"><svg class="ico"[\s\S]*?<\/svg><\/span><span class="lbl">Total tokens<\/span><\/dt>/
  );
  assert.doesNotMatch(html, /&lt;svg/, "the glyph is markup, not escaped source");
});

test("the rail marks where you are, and marks it once", () => {
  const html = layout("Incidents", "<p>hi</p>", { current: "/incidents" });
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

// The incident page used to buy a 58rem reading column with `.pane:has(.prose)`. It applied to
// the PAGE, so above ~1180px the fact strip and both record tables froze at that width too and
// the page stopped answering the screen — measured 928px of main at both 1440 and 1920. A
// measure that stops the figures growing to shorten the sentences is charged to the wrong block.
// If a line-length ceiling comes back it belongs on the text, inside .doc.
test("no page-wide measure is charged for the RCA's line length", () => {
  // The RULE, not the name: a comment may still mention where the measure used to live.
  assert.doesNotMatch(
    STYLES,
    /^\.pane:has\(\.prose\)/m,
    "the page is capped for the sake of its prose again"
  );
  const incident: IncidentDetail = {
    ...row, rca: "the container hit its limit", channel: "C1", thread_ts: "1785282508.001",
  };
  assert.match(
    detailPage({ incident, remediations: [], feedback: [] }),
    /class="prose/,
    "the RCA still marks its prose — a later text-level measure has this to hang on"
  );
});

// Below 46rem the stylesheet lays each incident row out as a card, and it does that by placing
// cells BY NAME. Three couplings have to hold together or the layout silently comes apart: every
// cell the rules place must exist, the rules must be scoped to this table (the remediation and
// feedback tables have different columns), and the table has to carry explicit roles — changing
// a <tr>'s display is what costs a table its semantics, and the roles are what survive it.
test("the incident table can become cards: named cells, scoped rules, roles intact", () => {
  const html = listPage(page([row]), parseFilters(new URLSearchParams("")));

  for (const cell of ["when", "primary", "ns", "sev", "state"]) {
    assert.match(html, new RegExp(`class="${cell}[ "]`), `no .${cell} cell for the card layout to place`);
    assert.match(
      STYLES,
      new RegExp(`table\\[data-cards\\] td\\.${cell}`),
      `.${cell} is rendered but the card layout never places it`
    );
  }
  assert.match(html, /<table role="table" data-cards>/, "only this table opts into the card layout");
  // Roles at every level or none: a role="table" whose rows have lost theirs is worse than
  // leaving the semantics to the display, because it claims a structure that is not there.
  for (const r of [/<thead role="rowgroup">/, /<tbody role="rowgroup">/, /<tr role="row"/, /<td role="cell"/, /<th role="columnheader">/]) {
    assert.match(html, r, `the role chain is broken at ${r}`);
  }
  // and the tables that did NOT ask for it keep the plain markup
  const detail = detailPage({
    incident: { ...row, rca: null, channel: null, thread_ts: null },
    remediations: [{
      id: 1, action: "k8s_scale", params: {}, status: "succeeded",
      approved_by: "U1", result: "applied", executed_at: new Date("2026-07-28T23:50:00Z"),
    } as RemediationRow],
    feedback: [],
  });
  assert.doesNotMatch(detail, /<table role="table" data-cards>[\s\S]*k8s_scale/, "remediation is not a card table");
});

// The width at which a table stops being a table is a number in a container query, and the
// only thing that can check it is arithmetic against the other number like it. Both blocks
// answer the same question — five columns no longer fit — so they answer it at the same width,
// and the pair is asserted rather than the value: 46rem is measured from the labels and cells
// these tables actually hold, and re-measuring it should move both or neither. It was 40rem on
// the record tables, and the 6rem between them was a band where .table-wrap did the one thing
// these blocks exist to prevent: scrolled Executed and When out of sight.
const queryAbove = (marker: string): number => {
  const at = STYLES.indexOf(marker);
  assert.ok(at > 0, `${marker} is not in the stylesheet — the layout it belongs to is gone`);
  const q = [...STYLES.slice(0, at).matchAll(/@container page \(max-width: ([\d.]+)rem\)/g)].pop();
  assert.ok(q, `${marker} is not inside a container query any more`);
  return Number(q[1]);
};

test("a record table stops being a table at the same width the incident list does", () => {
  assert.equal(queryAbove("table[data-stack] tbody td::before"), queryAbove("table[data-cards] thead"));
});

// What sets a record table's floor is its HEADER row, not its values: five nowrap captions in
// tracked-out uppercase ("Confirmed root cause" is twenty characters) demand more width than
// the sentences underneath them do, and the wrapper answers with a sideways scroll. A scan
// list keeps nowrap — there the captions are one line the eye runs along.
test("only a record table lets its headers wrap", () => {
  assert.match(STYLES, /table\[data-stack\] th \{[^}]*white-space: normal/);
  const base = STYLES.match(/^th \{([^}]*)\}/m);
  assert.ok(base, "no base th rule to check");
  assert.match(base[1], /white-space: nowrap/, "a list's headers still hold their line");
});

// Flex shrinks every item by its share, and the nav is the one item that cannot absorb a cut:
// its links are nowrap, so narrowing them only spills them past the right edge and takes the
// document sideways with them. Between 481 and 555px that was the whole cause of a horizontal
// scrollbar on every page of the dashboard. The brand is what gives way — it is the only item
// in the bar built to be cut, and it already carries the ellipsis to show it.
// The brand moved out of the rail and into the top bar, where it is the item built to be cut:
// it has the ellipsis, so it is what absorbs a squeeze rather than the controls beside it.
test("the brand is what gives way in the top bar, not the controls", () => {
  const brand = STYLES.match(/^\.topbar \.brand \{([^}]*)\}/m);
  assert.ok(brand, "no .topbar .brand rule to check");
  assert.match(brand[1], /min-width: 0/);
  assert.match(brand[1], /text-overflow: ellipsis/);
  // Its glyph tile must not shrink with it: a squeezed 4px tile is a rendering fault, not a mark.
  assert.match(STYLES, /\.topbar \.brand-mark \{[^}]*flex: 0 0 auto/);
  // And when the rail lies down across the top, sign-out holds its size for the same reason.
  assert.match(STYLES, /form\.signout \{[^}]*flex: 0 0 auto/);
});

test("a CamelCase alert name offers its humps as break points, and stays escaped", () => {
  const html = listPage(
    page([{ ...row, alertname: "PersistentVolumeFillingUp" }]),
    parseFilters(new URLSearchParams(""))
  );
  assert.match(html, /Persistent<wbr>Volume<wbr>Filling<wbr>Up/);

  // The <wbr> pass runs on already-escaped text, so it must not be a way back in.
  const hostile = listPage(
    page([{ ...row, alertname: `<img src=x onerror="alert(1)">Ab` }]),
    parseFilters(new URLSearchParams(""))
  );
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.match(hostile, /&lt;img src=x/);
  // and an entity is never split down the middle
  assert.doesNotMatch(listPage(page([{ ...row, alertname: "a&B" }]), parseFilters(new URLSearchParams(""))), /&<wbr>|&amp<wbr>/);
});

// The list gets <wbr>s put through it; the incident page's <h1> does not — it prints the
// alertname whole, because a heading peppered with break opportunities reads as one. So the
// break has to come from the stylesheet, and without it the title alone was 40px wider than a
// 320px screen and took the document with it. Both halves are asserted: the CSS that breaks
// it, and the markup fact that nothing else will.
test("the incident title breaks the identifier rather than the page", () => {
  const h1 = STYLES.match(/^h1 \{([^}]*)\}/m);
  assert.ok(h1, "no h1 rule to check");
  assert.match(h1[1], /overflow-wrap: anywhere/);
  assert.match(
    detailPage({ incident: { ...row, rca: null, channel: null, thread_ts: null }, remediations: [], feedback: [] }),
    /<h1>KubernetesContainerOomKiller<\/h1>/,
    "the title is one unbroken word — the stylesheet is the only thing that can break it"
  );
});

// What a model puts in an evidence cell is a metric selector, an image digest or a pod name:
// one token of sixty to ninety characters with nothing in it a line is allowed to break at.
// A td's overflow is visible, so the excess was not clipped — it printed straight across the
// Source column, on top of the tool name that backs the claim. The stacked step had this
// declaration all along; the tabular one is where the ink escaped. Scoped to .rca on purpose:
// the list breaks its alert names at CamelCase humps, and a hump is a better break than
// wherever the line happened to run out.
// It has to be "anywhere" and not "break-word": both break the token, but only "anywhere"
// lowers the cell's min-content claim, and an auto-layout table hands out width in proportion
// to what its columns claim — with break-word the Evidence table measured 300px past its own
// frame at 1024. The floor below is what that costs: Recommended Actions puts one word in the
// leading column, and a column claiming one character wide printed "Immediate" as "Immedia/te".
test("a metric selector breaks inside its evidence cell instead of over the next column", () => {
  const rule = STYLES.match(/^\.rca td \{([^}]*)\}/m);
  assert.ok(rule, "no .rca td rule to check");
  assert.match(rule[1], /overflow-wrap: anywhere/);
  assert.match(
    STYLES,
    /\.rca td\.primary \{[^}]*min-width: 12ch/,
    "nothing stops the label column collapsing under a word it cannot fit"
  );
  assert.doesNotMatch(
    STYLES,
    /^td \{[^}]*overflow-wrap/m,
    "every table on the dashboard now breaks mid-word, including the one with <wbr>s in it"
  );
});

// A log line is 200 characters and at 390px the excerpt box is 35 of them: six screens of
// sideways swiping to read one line, with no way to see its start and its end at once. So at
// the same width a table stops being a table, the excerpt stops being one line — and each line
// keeps a block of its own with a hanging indent, which is the only thing left saying where
// one entry ends and the next begins. Above that width the line still wins.
test("a log excerpt wraps where a table stops being a table, and keeps its line boundaries", () => {
  const base = STYLES.match(/^\.rca-code \{([^}]*)\}/m);
  assert.ok(base, "no .rca-code rule to check");
  assert.match(base[1], /overflow-x: auto/, "a log line no longer holds its shape on a desktop");
  assert.equal(
    queryAbove(".rca-code { white-space: pre-wrap"),
    queryAbove("table[data-stack] tbody td::before")
  );
  assert.match(
    STYLES,
    /\.rca-code span \{[^}]*text-indent: -2ch/,
    "a wrapped log line has nothing marking where the next one starts"
  );
});

// The one thing a heading has to do is outrank what it heads, and for five sections in a
// single card it is the only thing separating them. These were set at --fs-base over prose at
// --fs-md — 15px over 17px, a heading SMALLER than its own paragraph — and no amount of space
// above them fixed that: Root Cause, Evidence, Ruled Out and the rest read as one run. Asserted
// as arithmetic against the prose size rather than as a token name, because renaming the step
// is fine and inverting the pair is the bug.
const rem = (token: string): number => {
  const m = STYLES.match(new RegExp(`--${token}: ([\\d.]+)rem`));
  assert.ok(m, `--${token} is gone from the scale`);
  return Number(m[1]);
};

test("an RCA section heading is set larger than the prose underneath it", () => {
  const head = STYLES.match(/^\.rca-head \{([^}]*)\}/m);
  const prose = STYLES.match(/^\.prose-text \{([^}]*)\}/m);
  assert.ok(head && prose, "no .rca-head / .prose-text rules to check");
  const size = (rule: string) => {
    const m = rule.match(/font-size: var\(--(fs-[\w-]+)\)/);
    assert.ok(m, `no font-size in ${rule}`);
    return rem(m[1]);
  };
  assert.ok(size(head[1]) > size(prose[1]), "a section heading is no bigger than its own paragraph");
  // and it is the only thing at that size on the page — an h1 it can be mistaken for is worse
  // than no rank at all.
  assert.doesNotMatch(STYLES, /^h1 \{[^}]*font-size: var\(--fs-lg\)/m);
});

// renderBody emits a lead paragraph and then a table for the same section, and the two arrive
// as two framed blocks with no margin of their own — the panel's bottom edge met the table's
// top edge and the pair read as one box drawn twice. Every other adjacency in the card has a
// heading between it.
test("a section's lead paragraph is not flush against its own table", () => {
  assert.match(STYLES, /\.rca-sec > \.prose \+ \.table-wrap \{[^}]*margin-top/);
});

// The page has ONE width, and it is --maxw. Everything in the RCA — paragraph, list, table,
// divider — ends on the same right edge as the fact strip above it, which is what makes the
// two read as one column instead of a panel with a ragged margin beside it. Any max-width
// declared inside the RCA breaks that: the capped block stops short while its uncapped
// neighbours run on, and the 240px strip down the right comes straight back.
// Re-confirmed by measurement after the page measure was removed: a 68ch cap on .prose-text
// holds the line at 728px, but the section rule above it belongs to the document and keeps the
// column — 632px of hairline over nothing at 1920, 448px at 1440. A wider column makes the cap
// worse, not better, so this rule outlives the layout it was written against.
test("nothing inside the RCA sets a width of its own", () => {
  for (const sel of [".rca", ".prose", ".prose-text", ".rca-list", ".rca-head"]) {
    const rule = STYLES.match(new RegExp(`^\\${sel} \\{([^}]*)\\}`, "m"));
    if (!rule) continue;
    assert.doesNotMatch(
      rule[1],
      /max-width/,
      `${sel} caps itself — the page's --maxw is the only measure the RCA may have`
    );
  }
});

// The same floor, now stated against the only measure left. main's content box sits ~3rem inside
// --maxw, and the stat strip breaks its four tiles into two rows once its container drops under
// 54rem — so any page measure below that step silently rearranges the header above the RCA. This
// was the rule that made 58rem a floor rather than a taste; it outlives the rule it was written
// for, because a narrower --maxw would break the strip on every page, not just this one.
test("the page measure stays wide enough to keep the stat strip in one row", () => {
  const maxw = STYLES.match(/^:root \{[\s\S]*?--maxw: ([\d.]+)rem/m);
  assert.ok(maxw, "the page's column is gone");
  const step = STYLES.match(/@container page \(max-width: ([\d.]+)rem\) \{ \.stats \{/);
  assert.ok(step, "the stat strip's 4->2 step is gone");
  assert.ok(
    Number(maxw[1]) >= Number(step[1]) + 3,
    `--maxw ${maxw[1]}rem leaves the container at or under the ${step[1]}rem step — the fact strip will wrap to two rows`
  );
});

// Sections are separated by a rule rather than by a frame around each one. Slack separates them
// with a blank line; a page cannot, because a blank line here is one leading of a paragraph and
// reads as a paragraph break. What must not come back is the panel: a box has to be as wide as
// its widest neighbour while the text in it stops at the measure, and the difference was 188px
// of empty card beside every paragraph.
test("an RCA section is separated by a rule, not framed as a card", () => {
  assert.match(STYLES, /\.rca-sec \+ \.rca-sec \{[^}]*border-top: 1px solid/);
  const prose = STYLES.match(/^\.prose \{([^}]*)\}/m);
  assert.ok(prose, "no .prose rule to check");
  assert.doesNotMatch(prose[1], /background|border|padding/, "the RCA sections are framed again");
});

// The template writes a tool name as _italic_ because Slack mrkdwn has nothing else to mark one
// with. On a page with a second face, italic sans beside a mono argument in the same cell reads
// as two kinds of thing when it is one. Table cells only: an underscored word in a paragraph is
// a model emphasising a word, and that keeps its italic.
test("a tool name in a table cell is set in the data face, not italicised", () => {
  const rule = STYLES.match(/^\.rca td em \{([^}]*)\}/m);
  assert.ok(rule, "no .rca td em rule to check");
  assert.match(rule[1], /font-family: var\(--font-data\)/);
  assert.match(rule[1], /font-style: normal/);
  assert.doesNotMatch(STYLES, /^\.prose-text em \{/m, "prose emphasis has been made into data too");
});

// STYLES is one template literal, which is why this can only be caught here: a stray */ inside
// it fails no build and throws no error — the CSS parser takes everything up to the next { as a
// selector and silently drops the rule that followed. That is exactly how .rca td.primary went
// missing for a while, and the only reason it was noticed is that a column was measured.
test("the stylesheet's comments and blocks close where they open", () => {
  const bare = STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(bare, /\*\//, "a */ outside a comment: everything up to the next { is now a selector");
  assert.doesNotMatch(bare, /\/\*/, "an unterminated comment swallows the rest of the sheet");
  let depth = 0;
  for (const ch of bare) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    assert.ok(depth >= 0, "a } with no { — the rules after it are outside the block they belong to");
  }
  assert.equal(depth, 0, "an unclosed rule block");
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
  assert.equal([...html.matchAll(/class="primary"><a href="\/incidents\//g)].length, PAGE_SIZE);
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

// ---------- /context ----------

const CTX: ContextView = {
  core: { lines: 267, chars: 24_100, tokens: 8_034, body: "You are an expert DevOps AI Agent.\n\n## Scope of Work\nThis connected infrastructure only." },
  skills: [
    { name: "rca-format", description: "The exact Slack mrkdwn shape every RCA must take", when: "always", chars: 1_820, body: "*📍 Root Cause*\none paragraph" },
    { name: "oomkilled", description: "First tool calls for a container killed at its memory limit", when: "oomkill|exit code 137", chars: 940, body: "1. k8s_describe_pod" },
  ],
  backends: [
    { name: "heavy", model: "claude-opus-5", window: 200_000, reserve: 9_120, core: 8_034, tools: 4_100, available: 178_746 },
    { name: "light", model: "qwen2.5-32b-instruct", window: 32_000, reserve: 9_120, core: 8_034, tools: 4_100, available: 10_746 },
  ],
  effective: { backend: "light", available: 10_746 },
};

// The skills table holds sentences; the budget table holds seven short numbers. Which narrow
// layout each takes is decided by what the cells hold, and it only shows at 390px.
test("each context table takes the narrow layout its own cells call for", () => {
  const html = contextPage(CTX);
  assert.equal([...html.matchAll(/<table role="table" data-stack>/g)].length, 1, "the skills table");
  assert.equal([...html.matchAll(/<table role="table" data-stack data-pairs>/g)].length, 1, "the budget table");

  for (const t of html.matchAll(/<table role="table" data-stack(?: data-pairs)?>([\s\S]*?)<\/table>/g)) {
    const heads = [...t[1].matchAll(/<th role="columnheader">([^<]*)<\/th>/g)].map((m) => m[1]);
    const labels = [...t[1].matchAll(/<td role="cell"[^>]*data-label="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(labels.length % heads.length, 0, "a row is missing a captioned cell");
    for (const l of labels) assert.ok(heads.includes(l), `caption ${l} names no column of this table`);
  }
});

test("the page runs no JavaScript — the claim its CSP makes", () => {
  assert.doesNotMatch(contextPage(CTX), /<script/i);
});

// The body used to hang off the description in a <details> inside the row. It is up to 8000
// chars, so opening one pushed every skill below it off the screen and wrapped the text in one
// column's width. The list is now a list: description in the row, body on its own page.
test("the list names each skill and links it to its own page, and holds no body", () => {
  const html = contextPage(CTX);
  assert.match(html, /<a href="\/context\/oomkilled"><code translate="no">oomkilled<\/code><\/a>/);
  assert.match(html, /First tool calls for a container killed at its memory limit/);
  // Against the BODY: the stylesheet is inlined into every page, and the comment explaining
  // why the MCP table is laid out fixed names the element this asserts the absence of.
  assert.doesNotMatch(bodyOf(html), /<details/, "a body inside a row is what this page moved away from");
  assert.doesNotMatch(html, /k8s_describe_pod/, "the body belongs to the skill page, not the list");
});

// Laid straight into <main>, each block is its own full-width band sized only by its content —
// the eyebrow measured 880x11 — and the column stopped growing at 58rem, so past ~1180px the
// page ignored the screen entirely. One wrapper that takes its width from the column is what
// makes it a document: measured 1360 / 1176 / 760 / 468 at 1920 / 1440 / 1024 / 390.
test("a document page is one block that takes the column's width, capped by nothing of its own", () => {
  const rule = STYLES.match(/^\.doc \{([^}]*)\}/m);
  assert.ok(rule, ".doc has no rule — the wrapper is markup with no layout behind it");
  assert.match(rule[1], /width: 100%/, "an auto-width block shrinks to its content, not the column");
  assert.doesNotMatch(rule[1], /max-width/, "a measure here would stop the page following the screen");
  assert.doesNotMatch(STYLES, /\.pane:has\(\.skill-body\)/, "a skill body is a playbook, not a reading measure");

  // Both document-shaped pages, both wrapped: a skill and an RCA are each one thing read top to
  // bottom, and either one laid loose into <main> is a run of bands instead.
  assert.match(skillPage(CTX.skills[1]!), /<div class="doc">/);
  assert.match(
    detailPage({ incident: { ...row, rca: "x", channel: "C1", thread_ts: "1.0" }, remediations: [], feedback: [] }),
    /<div class="doc">/
  );
});

test("a skill page carries the whole body, its trigger, and the way back", () => {
  const html = skillPage(CTX.skills[1]!);
  assert.match(html, /<h1 translate="no">oomkilled<\/h1>/);
  assert.match(html, /<pre class="skill-body">1\. k8s_describe_pod<\/pre>/);
  assert.match(html, /<pre class="skill-body" translate="no">oomkill\|exit code 137<\/pre>/);
  assert.match(html, /<a class="standalone" href="\/context">/);
  // The rail still marks Context: a skill page is a page of that section, not a fifth destination.
  assert.match(html, /<a href="\/context" aria-current="page">/);
});

// "always" is not a regex and has no pattern to show — printing the word in a code block would
// present a literal as if it were the thing being matched.
test("an always-on skill states that instead of showing a pattern", () => {
  const html = skillPage(CTX.skills[0]!);
  assert.match(html, /<span class="badge">ALWAYS<\/span>/);
  assert.match(html, /whatever the alert says/);
  assert.doesNotMatch(html, /<pre class="skill-body" translate="no">/);
});

// Both "light" and "10,746" also appear in the budget table's own row for that backend, so
// matching them anywhere on the page passes with the statement deleted — which is the whole
// behaviour under test. Pin the sentence, on whitespace-flattened HTML so the template literal's
// indentation cannot break the match.
test("the effective budget is stated, not left to be inferred from the table", () => {
  const flat = contextPage(CTX).replace(/\s+/g, " ");
  assert.match(
    flat,
    /built to fit <code translate="no">light<\/code>, the smallest window — about 10,746 tokens/
  );
});

// Assert the escaped form is PRESENT — asserting the raw form is absent passes on a blank page.
// A skill is a file on disk that an operator wrote; the `when` regex is full of the characters
// markup is made of. The check follows the body to the page that now renders it — moving a
// value to a new template is exactly when an esc() gets dropped.
const HOSTILE_SKILL = {
  name: "x", description: 'a "quoted" one', when: '5xx|<b>|"q"', chars: 10, body: "<script>alert(1)</script>",
} as const;

test("a skill regex is escaped, not rendered, in the list", () => {
  const html = contextPage({ ...CTX, skills: [{ ...HOSTILE_SKILL }] });
  assert.match(html, /5xx\|&lt;b&gt;\|&quot;q&quot;/);
  assert.doesNotMatch(html, /<b>/);
});

test("a skill body and a regex are escaped, not rendered, on the skill page", () => {
  const html = skillPage({ ...HOSTILE_SKILL });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /5xx\|&lt;b&gt;\|&quot;q&quot;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("the nav offers Context and marks it current on its own page", () => {
  assert.match(contextPage(CTX), /<a href="\/context" aria-current="page">/);
});

// ---------- self-refresh ----------

// The overview is the page left open on a second monitor. A <meta> refresh rather than a
// script: this route sends no script-src at all, and a full re-request is also what re-runs
// the queries behind it.
test("the overview re-requests itself, and says so", () => {
  const html = overviewPage({ ...emptyOverview, tokens }, []);
  assert.match(html, new RegExp(`<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`));
  assert.match(html, /class="topbar-note live"/);
});

// A reader who has typed a filter is WORKING. Reloading the page under them mid-way through
// row seven is worse than leaving it stale, so the watch view is unfiltered page 1 and
// nothing else.
test("the incident list refreshes only while it is a watch view", () => {
  const watching = listPage(page([row]), parseFilters(new URLSearchParams("")));
  assert.match(watching, /<meta http-equiv="refresh"/);

  for (const qs of ["severity=critical", "namespace=prod", "page=2", "resolved=false"]) {
    assert.doesNotMatch(
      listPage(page([row]), parseFilters(new URLSearchParams(qs))),
      /<meta http-equiv="refresh"/,
      `?${qs} is a query someone typed, not a view left open`
    );
  }
});

// Every other page is read once and navigated away from — and the sign-in page reloading
// itself would discard a half-typed password.
test("no other page refreshes itself", () => {
  const others = [
    detailPage({ incident: { ...row, rca: "x", channel: null, thread_ts: null }, remediations: [], feedback: [] }),
    topologyPage(baseTopology, NONCE),
    contextPage(CTX),
    loginPage(),
    errorPage("Not found", "No incident with id 9."),
  ];
  for (const html of others) assert.doesNotMatch(html, /http-equiv="refresh"/);
});

// ---------- the time range ----------

test("the range control is three links, with the current one marked and the default bare", () => {
  const html = overviewPage({ ...emptyOverview, range: "7d", seriesUnit: "per day" }, []);
  const seg = html.slice(html.indexOf(`<nav class="seg"`), html.indexOf("</nav>"));
  assert.match(seg, /<a href="\/\?range=24h">24h<\/a>/);
  assert.match(seg, /<a href="\/\?range=7d" aria-current="true">7d<\/a>/);
  // the default range is the bare path: a URL that restates the default is noise in the bar
  assert.match(seg, /<a href="\/">30d<\/a>/);
  assert.equal([...seg.matchAll(/aria-current/g)].length, 1, "exactly one range is current");
});

// The window is in the heading and in the recurring table's empty state, and both read it off
// the same value the queries were run with — a heading that says "30 days" over figures
// measured across 24 hours is the failure this guards.
test("the page names the window it was actually measured over", () => {
  assert.match(overviewPage({ ...emptyOverview, range: "24h" }, []), /last 24 hours/);
  assert.match(overviewPage({ ...emptyOverview, range: "7d" }, []), /last 7 days/);
  assert.match(overviewPage({ ...emptyOverview, range: "30d" }, []), /last 30 days/);
});

// ---------- deltas ----------

test("a delta reports the direction it moved and whether that is good news", () => {
  const worse = overviewPage(
    { ...emptyOverview, totalIncidents: 20, resolvedIncidents: 5,
      prev: { totalIncidents: 20, openIncidents: 10, mttrMs: null, feedbackTotal: 0 } },
    []
  );
  // 15 open against 10: up by 5, and up is bad news for open incidents
  assert.match(worse, /<span class="delta" data-dir="up" data-tone="critical">5<\/span>/);

  const better = overviewPage(
    { ...emptyOverview, totalIncidents: 20, resolvedIncidents: 18,
      prev: { totalIncidents: 20, openIncidents: 10, mttrMs: null, feedbackTotal: 0 } },
    []
  );
  assert.match(better, /<span class="delta" data-dir="down" data-tone="ok">8<\/span>/);
});

// Down is GOOD for a time to resolve and BAD for a resolution rate, so direction and judgement
// are two separate inputs. A component that inferred one from the other is wrong on half the
// shelf — which is the whole reason delta() takes `better`.
test("a shorter time to resolve is good news even though the arrow points down", () => {
  const html = overviewPage(
    { ...emptyOverview, mttrMs: 10 * 60_000, resolvedIncidents: 3, totalIncidents: 3,
      prev: { totalIncidents: 3, openIncidents: 0, mttrMs: 30 * 60_000, feedbackTotal: 0 } },
    []
  );
  assert.match(html, /<span class="delta" data-dir="down" data-tone="ok">20m<\/span>/);
});

// Every figure is up by infinity against a window that held nothing. That is a rendering
// artefact, not a finding.
test("no delta is drawn against an empty previous window", () => {
  const html = overviewPage({ ...emptyOverview, totalIncidents: 9, resolvedIncidents: 2 }, []);
  assert.doesNotMatch(html, /class="delta"/);
});

// An unchanged figure is neither good news nor bad, and colouring it either way is a claim
// the number does not make.
test("an unchanged figure gets an arrow and no tone", () => {
  const html = overviewPage(
    { ...emptyOverview, totalIncidents: 10, resolvedIncidents: 6,
      prev: { totalIncidents: 10, openIncidents: 4, mttrMs: null, feedbackTotal: 0 } },
    []
  );
  assert.match(html, /<span class="delta" data-dir="flat">0<\/span>/);
});

// ---------- duration ----------

// Both timestamps were already on this shelf; the interval between them — the only number that
// says how bad the incident WAS — had to be worked out by subtracting one tile from another.
test("the incident page states how long it took, or how long it has been open", () => {
  const fired = new Date("2026-08-24T02:00:00Z");
  const now = new Date("2026-08-24T05:30:00Z");

  const open = detailPage(
    { incident: { ...row, created_at: fired, resolved_at: null, rca: "x", channel: null, thread_ts: null }, remediations: [], feedback: [] },
    now
  );
  assert.match(open, /Open for<\/span>[\s\S]*?<dd>3h 30m<span>still firing/);
  // still firing is a state, not a zero duration — the tile says so with the warning tone
  assert.match(open, /<div class="stat" data-tone="warning">[\s\S]*?Open for/);

  const done = detailPage(
    { incident: { ...row, created_at: fired, resolved_at: new Date("2026-08-24T02:45:00Z"), rca: "x", channel: null, thread_ts: null }, remediations: [], feedback: [] },
    now
  );
  assert.match(done, /Time to resolve<\/span>[\s\S]*?<dd>45m<span>fired to resolved/);
  // Scoped to the shelf: this incident's SEVERITY is "warning", and the page says so on the
  // badge beside the title. What must not be toned is the duration tile.
  const shelf = done.slice(done.indexOf(`<dl class="stats facts">`), done.indexOf("</dl>"));
  assert.doesNotMatch(shelf, /data-tone=/, "a resolved duration is not a warning");
});

// ---------- relative time ----------

// The absolute instant never leaves the page — it moves into datetime= and title=, which is
// what keeps it machine-readable and one hover from an on-call who needs to paste it.
test("timestamps read as relative and keep the exact instant in the element", () => {
  const now = new Date("2026-07-29T00:00:00Z");
  const html = listPage(page([row]), parseFilters(new URLSearchParams("")), now);
  assert.match(html, /<time datetime="2026-07-28T23:48:00\.000Z" title="2026-07-28 23:48Z">12m ago<\/time>/);
});

// One instant per response, threaded from the caller. Computed per row instead, a list
// rendered across a minute boundary says "1h ago" and "59m ago" about two incidents a second
// apart — the kind of inconsistency nobody reports and everybody notices.
test("every row on a page is dated against the same instant", () => {
  const now = new Date("2026-07-29T00:00:00Z");
  const rows = [
    { ...row, id: 1, created_at: new Date("2026-07-28T23:00:00Z") },
    { ...row, id: 2, created_at: new Date("2026-07-28T22:59:59Z") },
  ];
  const html = listPage(page(rows), parseFilters(new URLSearchParams("")), now);
  assert.match(html, />1h ago</);
  assert.doesNotMatch(html, />59m ago</, "the second row was dated against a later clock");
});

// `grid-row: 2` on .pane put the sign-in card at the bottom of the viewport: body.bare has one
// row, so naming the second one created an implicit row above it. Auto-placement is correct in
// all three layouts — beside the rail, under it, and alone on a bare page — so the pane names
// no row at all, and this is what keeps it that way.
test("the pane places itself, so a chrome-less page starts at the top", () => {
  const pane = STYLES.match(/^\.pane \{([^}]*)\}/m);
  assert.ok(pane, "no .pane rule to check");
  assert.doesNotMatch(pane[1], /grid-row/, "a named row breaks the bare layout");
  assert.doesNotMatch(STYLES, /\.pane \{[^}]*grid-row/);
});

// The top bar is stuck at 0 and the rail is stuck under it. CSS cannot read a sibling's
// height, so the two agree through a token — and a literal in either place is a rail that
// slides under the bar the next time the bar's contents change.
test("the rail's sticky offset is the top bar's height, by token", () => {
  assert.match(STYLES, /\.topbar \{[^}]*height: var\(--topbar-h\)/);
  assert.match(STYLES, /\.rail \{[^}]*top: var\(--topbar-h\)/);
  assert.match(STYLES, /\.rail \{[^}]*height: calc\(100vh - var\(--topbar-h\)\)/);
});

// ---------- affordance ----------

// The restyle gave every stat card a shadow and a hover lift, which is a page telling a reader
// "this can be clicked". Two of them now can. The rest must not make the promise: the lift is
// scoped to [data-linked], and only a tile with a real destination carries it.
test("only a stat with somewhere to go is marked as going anywhere", () => {
  const html = overviewPage({ ...emptyOverview, tokens, totalIncidents: 10, resolvedIncidents: 7 }, []);
  const linked = [...html.matchAll(/<div class="stat"[^>]*data-linked[^>]*>/g)];
  assert.equal(linked.length, 2, "Open and Resolved lead to the filtered list; nothing else does");
  assert.match(html, /<a class="stat-link" href="\/incidents\?resolved=false"/);
  assert.match(html, /<a class="stat-link" href="\/incidents\?resolved=true"/);

  // The incident page's fact shelf is identity, not a way in — no link, so no promise.
  // Scoped to the shelf: the stylesheet is inlined into every page and names the selector too.
  const detail = detailPage({ incident: { ...row, rca: "x", channel: null, thread_ts: null }, remediations: [], feedback: [] });
  const facts = detail.slice(detail.indexOf(`<dl class="stats facts">`), detail.indexOf("</dl>"));
  assert.ok(facts, "no fact shelf to check");
  assert.doesNotMatch(facts, /data-linked/);
  assert.doesNotMatch(facts, /stat-link/);
});

// The visible label is one word and the destination is a filtered list, so the anchor has to
// say more than the tile shows or a screen reader hears four links called "Open", "Resolved"…
test("a linked stat names its destination for a reader who cannot see the tile", () => {
  const html = overviewPage({ ...emptyOverview, totalIncidents: 10, resolvedIncidents: 7 }, []);
  assert.match(html, /aria-label="Open — see the 3 incidents still firing"/);
  assert.match(html, /aria-label="Resolved — see the 7 incidents that closed"/);
});

// The lift is a promise; the CSS is where it is kept or broken.
test("the hover lift is scoped to linked tiles in the stylesheet too", () => {
  assert.match(STYLES, /\.stat\[data-linked\]:hover \{[^}]*transform: translateY/);
  assert.doesNotMatch(STYLES, /^\s*\.stat:hover/m, "an unscoped lift promises what inert tiles cannot keep");
});

// ---------- state emphasis ----------

// The column exists to say which incidents are still live. Firing wore the neutral badge and
// resolved wore green, so the live rows were the quietest thing in it.
test("the state column emphasises firing, not resolved", () => {
  const html = listPage(page([{ ...row, resolved_at: null }]), parseFilters(new URLSearchParams("")));
  assert.match(html, /<span class="badge" data-live>firing<\/span>/);
  // and it spends weight rather than colour — severity is one cell to the left already
  assert.match(STYLES, /\.badge\[data-live\] \{[^}]*color: var\(--text\)/);
  assert.doesNotMatch(STYLES, /\.badge\[data-live\] \{[^}]*var\(--critical\)/);

  const resolved = listPage(page([{ ...row, resolved_at: new Date() }]), parseFilters(new URLSearchParams("")));
  assert.match(resolved, /<span class="badge" data-tone="ok">resolved<\/span>/);
});

// ---------- tone vocabulary ----------

// A mark (a spine, a dot, an arc, a swatch) is a graphic and needs 3:1; type in a tone needs
// 4.5:1 on its own tint. One ramp cannot be both, and the one that could be read as 11px type
// on white is the one that turned amber into brown.
test("marks and type draw from different ramps", () => {
  for (const t of ["critical", "warning", "info", "ok"]) {
    assert.match(
      STYLES,
      new RegExp(`\\[data-tone="${t}"\\]\\s*\\{[^}]*--spine: var\\(--mark-${t}\\)`),
      `${t}'s mark is not drawn from the graphic ramp`
    );
    assert.match(
      STYLES,
      new RegExp(`\\[data-tone="${t}"\\]\\s*\\{[^}]*--ink: var\\(--${t}\\)`),
      `${t}'s type is not drawn from the readable ramp`
    );
  }
  // and a badge's label is type, while its dot is a mark
  assert.match(STYLES, /\.badge\[data-tone\] \{[^}]*color: var\(--ink\)/);
  assert.match(STYLES, /\.badge::before \{[^}]*background: var\(--spine/);
});

// ---------- one segmented control ----------

// The topology page's scale control and the overview's time range are the same component doing
// the same job. The markup differs because the mechanism does (radios cannot be links); the
// look must not.
test("the topology scale control is the shared segmented control", () => {
  assert.match(topologyPage(baseTopology, NONCE), /<div class="topo-bar"><div class="seg">/);
  assert.match(STYLES, /\.seg a, \.seg label, \.seg button \{/);
});

// ---------- empty states ----------

// A window with no incidents is the good outcome, and a fresh deployment is the ordinary first
// hour. A dashed outline says "this failed to load"; a real surface says "this is the answer".
test("an empty state is a panel, and wears the glyph of the section it stands in", () => {
  const html = detailPage({ incident: { ...row, rca: "", channel: null, thread_ts: null }, remediations: [], feedback: [] });
  assert.match(html, /<div class="empty"><span class="kpi-icon" aria-hidden="true"><svg class="ico"/);
  assert.doesNotMatch(STYLES, /\.empty \{[^}]*border: 1px dashed/);
  // the wrench stands in for Remediation, the speech bubble for on-call — the same glyphs
  // those sections carry when they do have rows
  assert.equal([...html.matchAll(/<div class="empty">/g)].length, 3, "RCA, remediation, feedback");
});

// ---------- post-remediation verdicts ----------

// A remediation row, with the check that annotates it. Defaults describe the ordinary case —
// an approved action whose check has not run yet — so a test states only what it is about.
const remRow = (over: Partial<RemediationRow> = {}): RemediationRow => ({
  action: "restart_deployment",
  params: { name: "speaker" },
  status: "succeeded",
  approved_by: "U123",
  result: "rollout complete",
  created_at: new Date("2026-08-24T02:20:00Z"),
  executed_at: new Date("2026-08-24T02:21:00Z"),
  verdict: null,
  verdict_detail: null,
  check_status: "pending",
  checked_at: null,
  due_at: new Date("2026-08-24T02:26:00Z"),
  ...over,
});
const withRem = (r: RemediationRow, now = new Date("2026-08-24T02:22:00Z")): string =>
  detailPage(
    { incident: { ...row, rca: "x", channel: null, thread_ts: null }, remediations: [r], feedback: [] },
    now
  );

// THE test for this feature. The two facts disagree exactly where it matters: the call
// returned 200 and the alert kept firing. Before this the page showed only the first half.
test("status and verdict are both rendered, and are allowed to disagree", () => {
  const html = withRem(remRow({
    status: "succeeded",
    verdict: "unchanged",
    verdict_detail: "`KubeOom` is still firing; 2/3 pods ready, 4 restart(s)",
    check_status: "done",
  }));
  assert.match(html, /data-label="Status"><span class="badge" data-tone="ok">succeeded<\/span>/);
  assert.match(html, /data-label="Verdict"><span class="badge" data-tone="warning">unchanged<\/span>/);
  // and the evidence the verdict was read from travels with it
  assert.match(html, /2\/3 pods ready, 4 restart\(s\)/);
});

// The spine is the row's one-glance reading, so it has to carry the fact that describes the
// cluster rather than the one that describes the API.
test("the row's tone follows the verdict, and falls back to the status only without one", () => {
  const disagreeing = withRem(remRow({ status: "succeeded", verdict: "worse", check_status: "done" }));
  const rows = disagreeing.match(/<tr role="row" data-tone="(\w+)">/g) ?? [];
  assert.ok(rows.some((r) => r.includes('data-tone="critical"')), "a worse verdict must tone the row");

  // no check at all — an unapproved proposal — falls back to what the call said
  const noCheck = withRem(remRow({ status: "failed", verdict: null, check_status: null, due_at: null }));
  assert.match(noCheck, /<tr role="row" data-tone="critical">/);
});

// "pending" with no horizon is indistinguishable from a poller that has stopped.
test("a check that has not run says when it will, forwards", () => {
  const html = withRem(remRow({ due_at: new Date("2026-08-24T02:26:00Z") }), new Date("2026-08-24T02:22:00Z"));
  assert.match(html, /<span class="badge">checking<\/span>/);
  assert.match(html, /next check in 4m/);
  // fmtAgo clamps a future instant to "just now" — using it here would report a check that
  // is four minutes away as one that already ran.
  assert.doesNotMatch(html, /next check just now/);
});

test("a check whose time has passed says so rather than counting backwards", () => {
  const html = withRem(remRow({ due_at: new Date("2026-08-24T02:00:00Z") }), new Date("2026-08-24T02:22:00Z"));
  assert.match(html, /check overdue/);
});

// A remediation that was proposed and never approved was never going to be verified. A
// "pending" it will never leave is worse than saying nothing.
test("a remediation with no check shows a dash, not a pending state", () => {
  const html = withRem(remRow({ status: "proposed", verdict: null, check_status: null, due_at: null }));
  const cell = html.match(/data-label="Verdict">([\s\S]*?)<\/td>/)?.[1];
  assert.ok(cell, "no verdict cell");
  assert.doesNotMatch(cell, /checking/);
  assert.match(cell, /—/);
});

// "we looked and the evidence says nothing either way" is not a finding, and a colour would
// make it one.
test("inconclusive carries no tone", () => {
  const html = withRem(remRow({ verdict: "inconclusive", check_status: "done" }));
  assert.match(html, /data-label="Verdict"><span class="badge">inconclusive<\/span>/);
});

// ---------- the overview figure that was measuring the wrong thing ----------

// It reported `status = succeeded` over all remediations — how many API calls did not error.
// The tile now reports verdicts, and the call counts drop to the sub-line where they belong.
test("the remediation tile reports what the cluster did, not what the API returned", () => {
  const html = overviewPage(
    { ...emptyOverview,
      remediationSucceeded: 9, remediationFailed: 1,
      verdicts: { recovered: 3, unchanged: 5, inconclusive: 2 } },
    []
  );
  // 3 recovered of 10 that reached a verdict — not 9 of 10 calls that returned 200
  assert.match(html, />Remediation verified<\/span>[\s\S]*?<dd>30%/);
  assert.match(html, /9 of 10 calls succeeded/);
  assert.doesNotMatch(html, /Remediation applied/, "the old label described the wrong measurement");
});

// A check still waiting is not a failure and not a success; counting it either way moves the
// percentage for a reason nobody did.
test("a pending check is left out of the denominator", () => {
  const html = overviewPage(
    { ...emptyOverview, verdicts: { recovered: 1, unchanged: 1 }, verdictsPending: 8 },
    []
  );
  assert.match(html, />Remediation verified<\/span>[\s\S]*?<dd>50%/);
});

// The single most consequential thing this system can do, and it had no representation on the
// page at all.
test("a remediation that made things worse is impossible to skim past", () => {
  const html = overviewPage(
    { ...emptyOverview, verdicts: { recovered: 4, worse: 1 }, verdictsPending: 2 },
    []
  );
  // its own figure, in the outcomes panel
  assert.match(html, />Made it worse<\/span>[\s\S]*?<dd>1</);
  // and the tile above it wears the tone, so the top of the page carries it too
  assert.match(html, /<div class="stat" data-tone="critical">[\s\S]*?Remediation verified/);
});

// At zero it keeps its place: a reader has to see that the answer is none rather than infer
// it from a tile that is not there.
test("the worse figure is shown at zero, untoned", () => {
  const html = overviewPage({ ...emptyOverview, verdicts: { recovered: 4 } }, []);
  assert.match(html, />Made it worse<\/span>[\s\S]*?<dd>0</);
  assert.doesNotMatch(html, /<div class="stat" data-tone="critical">[\s\S]*?Made it worse/);
});

// Found by looking at the render: falling back to the status while a check was still pending
// put a green spine on a row whose outcome nobody had measured yet — `succeeded` reading as
// "it worked", which is the exact masquerade this feature exists to stop.
test("a row whose check has not concluded carries no tone at all", () => {
  const html = withRem(remRow({ status: "succeeded", verdict: null, check_status: "pending" }));
  const tr = html.match(/<tr role="row"[^>]*>/g)?.find((t) => !t.includes("data-tone")) ?? "";
  assert.equal(tr, `<tr role="row">`, "a pending verdict must not borrow the call's green");
  // and the cell still says a check is coming, so the absence of a tone is not an absence of
  // information
  assert.match(html, /checking/);
});

// ---------- vertical rhythm ----------

// The page had none: spacing came from the headings' own margins, so any two blocks a heading
// separated were spaced and any two it did not were touching. The KPI shelf sat edge to edge
// with the hero, and the token shelf with the backend table — both are one section holding two
// blocks, which is the case nothing covered.
test("stacked blocks are spaced by the page, not by whichever of them owns a margin", () => {
  assert.match(STYLES, /main > \* \+ \* \{ margin-top: var\(--stack\); \}/);
  // and the components it covers must not have opted themselves out with a margin of their own
  assert.match(STYLES, /\.stats \{[^}]*margin: 0/, ".stats declaring its own margin would fight the rule");
});

// Three levels, each clearly larger than the one nested inside it. When the block step and the
// section step were both --sp-6 a section boundary said nothing the heading had not already
// said, and at the grid step the hero read as a fifth KPI card.
test("the grid, block and section steps are three distinct sizes", () => {
  assert.match(STYLES, /--stack: var\(--sp-6\);/);
  assert.match(STYLES, /\.stats \{[^}]*gap: var\(--sp-4\)/, "peer cards sit on the smallest step");
  // the section step's FLOOR has to clear --stack, or the two collapse into one reading
  const h2 = STYLES.match(/^h2, \.eyebrow \{[\s\S]*?\}/m)?.[0] ?? "";
  assert.match(h2, /margin: clamp\(var\(--sp-8\)/, "the section step must start above --stack");
});

// A document page's body is a single .doc, so main's rule never reaches inside it — which is
// what keeps an eyebrow tight against the title it labels.
test("the rhythm does not loosen the lockups inside a document page", () => {
  const html = detailPage({ incident: { ...row, rca: "x", channel: null, thread_ts: null }, remediations: [], feedback: [] });
  const body = html.split("</style>")[1];
  const main = body.slice(body.indexOf(`<main id="main">`), body.indexOf("</main>"));
  const children = [...main.matchAll(/<(div|section|h1|h2|p|table|figure)\b/g)];
  assert.ok(children.length > 0);
  assert.match(main, /<main id="main"><div class="doc">/, "the doc wrapper is what shields the lockups");
});

// The whole stylesheet is one template literal, so a backtick in a CSS comment ends it and the
// file stops compiling. That has happened three times while writing these comments — always
// from quoting a CSS keyword the way prose quotes code. This is the cheap guard: the source
// must contain exactly one backtick after the opening one, and it must be the closing one.
test("no comment in the stylesheet contains a backtick", async () => {
  const src = await readFile(new URL("./styles.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export const STYLES = `") + "export const STYLES = `".length);
  assert.equal(
    (body.match(/`/g) ?? []).length,
    1,
    "a backtick inside the CSS ends the template literal — quote CSS keywords with ' instead"
  );
});

// Two cards side by side are one row and must end on the same line. `align-items: start` made
// each take its own content height, so above 58rem the ring stood about 90px taller than the
// two-tile shelf beside it and the row read as ragged. Only visible at wide widths — below
// 58rem there is one column and nothing to align.
test("the outcomes panels are one row, so they end together", () => {
  const split = STYLES.match(/^\.split \{[\s\S]*?\}/m)?.[0] ?? "";
  assert.ok(split, "no .split rule");
  assert.match(split, /align-items: stretch/);
  assert.doesNotMatch(split, /align-items: start/, "start is what made the row ragged");
});

// A stretched card is taller than its contents, and the shorter of the two would otherwise end
// in a hundred pixels of nothing. The caption stays at the top; the figure block takes the
// leftover room symmetrically.
test("a stretched card centres its figures instead of leaving a void", () => {
  assert.match(STYLES, /\.split > \.card \{[^}]*display: flex[^}]*flex-direction: column/);
  assert.match(STYLES, /\.split > \.card > \.donut,\s*\.split > \.card > \.stats \{[^}]*margin-top: auto/);
});

// ---------- the rail ----------

// Four destinations were one flat list, and they are two different kinds of thing: what the
// cluster did, and what this process is. The caption is associated with its own list rather
// than floating above it, so the grouping exists for a screen reader too.
test("the rail groups its destinations, and each caption labels its own list", () => {
  const html = layout("Test", "<p>hi</p>", { current: "/" });
  assert.match(html, /<p class="rail-group" id="rail-g0">Monitor<\/p><ul aria-labelledby="rail-g0">/);
  assert.match(html, /<p class="rail-group" id="rail-g1">Agent<\/p><ul aria-labelledby="rail-g1">/);
  // still four destinations, and still exactly one marked
  assert.equal([...html.matchAll(/<li><a href="/g)].length, 4);
  assert.equal([...html.matchAll(/<a href="[^"]*" aria-current="page">/g)].length, 1);
});

// The number a reader wants is now visible from every page, not only from the overview.
test("the rail carries the open count on the destination that lists them", () => {
  const html = layout("Test", "<p>hi</p>", { current: "/", openIncidents: 17 });
  assert.match(html, /<a href="\/incidents">[\s\S]*?<span class="rail-count">17<span class="sr-only"> open<\/span><\/span>/);
  // and only there — a count beside Topology would be counting nothing it lists
  assert.equal([...html.matchAll(/class="rail-count"/g)].length, 1);
});

// "Nothing is on fire" is what an absent badge already says. A rail that always carries a
// number trains the eye to stop reading it.
test("no badge at zero", () => {
  assert.doesNotMatch(bodyOf(layout("Test", "<p>hi</p>", { openIncidents: 0 })), /rail-count/);
});

// undefined is not zero. A page that could not read the count must not assert that nothing is
// firing — that is exactly the wrong thing to say when the reason is that the database is down.
test("no badge when the count is unknown", () => {
  assert.doesNotMatch(bodyOf(layout("Test", "<p>hi</p>", {})), /rail-count/);
  assert.doesNotMatch(bodyOf(layout("Test", "<p>hi</p>", { openIncidents: undefined })), /rail-count/);
});

// Four digits in a nav badge is not a number anyone reads.
test("the badge is bounded", () => {
  assert.match(layout("Test", "<p>hi</p>", { openIncidents: 4000 }), />999\+<span class="sr-only">/);
  assert.match(layout("Test", "<p>hi</p>", { openIncidents: 999 }), />999<span class="sr-only">/);
});

// The session note moved out of the top bar, where it was also the first thing dropped when the
// bar ran out of room — a poor place for the only statement that this dashboard is read-only.
test("the session note sits at the foot of the rail, not in the top bar", () => {
  const html = layout("Test", "<p>hi</p>", { current: "/" });
  assert.match(html, /<div class="rail-foot"><p class="rail-note">Read-only · session \d+h<\/p>/);
  const bar = bodyOf(html).slice(
    bodyOf(html).indexOf(`<header class="topbar">`),
    bodyOf(html).indexOf(`<header class="rail">`)
  );
  assert.doesNotMatch(bar, /session/, "the note is the rail's now");
});

// Only the live indicator describes THIS page, which is what the bar is for.
test("the top bar keeps the live indicator and nothing else of its own", () => {
  const refreshing = layout("Test", "<p>hi</p>", { refresh: true });
  assert.match(refreshing, /<span class="topbar-note live">updates every \d+s<\/span>/);
  const still = bodyOf(layout("Test", "<p>hi</p>", { refresh: false }));
  assert.doesNotMatch(still, /topbar-note/);
});

// A bare page has no rail at all, so it has no badge and no note to render.
test("a bare page renders neither the badge nor the note", () => {
  const html = bodyOf(layout("Sign in", "<p>hi</p>", { chrome: "bare", openIncidents: 9 }));
  assert.doesNotMatch(html, /rail-count|rail-note|rail-group/);
});

// The count is chrome, so every page carries it — including the two with no database of their
// own. A page that forgot to thread it through would silently lose the badge on that route.
test("every page renders the badge, not just the ones with a database", () => {
  const pages: [string, string][] = [
    ["overview", overviewPage({ ...emptyOverview, tokens }, [], new Date(), 17)],
    ["list", listPage(page([row]), parseFilters(new URLSearchParams("")), new Date(), 17)],
    ["detail", detailPage({ incident: { ...row, rca: "x", channel: null, thread_ts: null }, remediations: [], feedback: [] }, new Date(), 17)],
    ["topology", topologyPage(baseTopology, NONCE, 17)],
    ["context", contextPage(CTX, 17)],
    ["skill", skillPage(CTX.skills[0], 17)],
  ];
  for (const [name, html] of pages) {
    assert.match(html, /<span class="rail-count">17/, `${name} drops the badge`);
  }
});

// Measured, not eyeballed: --text-dim at .75 alpha over the light surface renders #828a93,
// which is 3.50:1 — under the 4.5:1 this 11px text needs. What makes a rail caption read as a
// caption is its size, tracking and case, none of which cost contrast.
test("nothing in the rail dims itself with opacity", () => {
  for (const sel of ["\\.rail-group", "\\.rail-note"]) {
    const rule = STYLES.match(new RegExp(`^${sel} \\{[^}]*\\}`, "m"))?.[0] ?? "";
    assert.ok(rule, `no ${sel} rule`);
    assert.doesNotMatch(rule, /opacity/, `${sel} buys its hierarchy with contrast it cannot spare`);
  }
});

// The separation is a hairline plus a weight step — not colour, which belongs to severity.
test("sign out is not shaped like a fifth destination", () => {
  assert.match(STYLES, /form\.signout button \{[^}]*font-weight: 500/);
  assert.match(STYLES, /\.rail-foot \{[^}]*border-top: 1px solid var\(--border\)/);
});

// Below 60rem the rail lies down, and the structure that made sense down a column has to be
// unmade: a caption belongs above the items it labels, and inline between them it reads as a
// sixth and seventh destination. This is a viewport media query, so it cannot be rendered in
// the preview harness — the guard is that the block still resets each thing it has to.
test("the horizontal bar unmakes the column's structure", () => {
  const bar = STYLES.match(/@media \(max-width: 60rem\)[^{]*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(bar, "no bar block");
  assert.match(bar, /\.rail-group \{ display: none/, "captions would read as extra destinations");
  assert.match(bar, /\.rail nav ul \{[^}]*flex-direction: row/);
  assert.match(bar, /\.rail-foot \{[^}]*border-top: 0/, "a rule above a foot that is no longer a foot");
  assert.match(bar, /\.rail-note \{ display: none/, "the page footer carries it in full anyway");
  // the grouping survives for a screen reader — the lists stay lists
  assert.doesNotMatch(bar, /\.rail nav ul \{[^}]*display: contents/);
});

// ---------- the mobile drawer ----------

// A checkbox, because a page with no script policy has no other way to hold a toggle. The
// objection that ruled out a COLLAPSE toggle does not apply: that one is a preference and would
// have to survive navigation, which a server-rendered page cannot do. A drawer is transient,
// and closing when you pick a destination is what it should do.
test("the drawer is a checkbox the label toggles, and ships no script", () => {
  const html = layout("Test", "<p>hi</p>", { current: "/" });
  const body = bodyOf(html);
  assert.match(body, /<input type="checkbox" id="nav-open" class="nav-state" aria-label="Navigation menu">/);
  assert.match(body, /<label class="nav-toggle" for="nav-open" aria-hidden="true">/);
  assert.doesNotMatch(body, /<script/, "the whole point of the checkbox is that there is none");
});

// The combinator only reaches forward, so the input has to precede everything it styles.
test("the checkbox precedes the scrim and the rail it opens", () => {
  const body = bodyOf(layout("Test", "<p>hi</p>", { current: "/" }));
  const input = body.indexOf(`id="nav-open"`);
  assert.ok(input >= 0);
  assert.ok(input < body.indexOf(`class="nav-scrim"`), "the scrim is out of the combinator's reach");
  assert.ok(input < body.indexOf(`<header class="rail">`), "the rail is out of the combinator's reach");
});

// The label carries no accessible name: the checkbox has it, and naming both announces the
// control twice.
test("the drawer control is named once", () => {
  const body = bodyOf(layout("Test", "<p>hi</p>", { current: "/" }));
  assert.equal([...body.matchAll(/aria-label="Navigation menu"/g)].length, 1);
  assert.match(body, /<label class="nav-toggle"[^>]*aria-hidden="true"/);
  // the scrim duplicates a control that is already in the tab order, so it is hidden too
  assert.match(body, /<label class="nav-scrim" for="nav-open" aria-hidden="true">/);
});

// A drawer that is only translated out of sight is still in the tab order: a keyboard user
// lands in a menu they cannot see. visibility is what takes it out.
test("the closed drawer is out of the tab order, not merely off-screen", () => {
  // Matched on the rules themselves, not on the block. There are two @media blocks at 46rem —
  // the typographic one and the drawer — and a regex anchored to the breakpoint picks whichever
  // comes first in the file.
  assert.match(STYLES, /\.rail \{[^}]*transform: translateX\(-100%\)[^}]*visibility: hidden/);
  assert.match(STYLES, /#nav-open:checked ~ \.rail \{[^}]*transform: none; visibility: visible/);
});

// The input is a 1px box in the corner, so its own ring would be invisible — it has to be
// painted on the label a pointer actually sees.
test("the drawer control shows a focus ring", () => {
  assert.match(STYLES, /\.nav-state:focus-visible ~ \.topbar \.nav-toggle \{[^}]*outline: 2px solid var\(--accent\)/);
});

// A bare page has no rail, so it has nothing to open.
test("a bare page ships no drawer machinery", () => {
  const body = bodyOf(layout("Sign in", "<p>hi</p>", { chrome: "bare" }));
  assert.doesNotMatch(body, /nav-open|nav-toggle|nav-scrim/);
});

// The bar and the drawer are different answers at different widths and must not both apply:
// the bar block now stops where the drawer starts.
test("the bar and the drawer do not overlap", () => {
  assert.match(STYLES, /@media \(max-width: 60rem\) and \(min-width: 46\.0625rem\)/);
  assert.match(STYLES, /@media \(max-width: 46rem\) \{/);
});

// It replaced an icons-only bar that clipped every label. A drawer keeps them, so the clip is
// gone — and it has to be, because the rail now also carries group captions and a badge.
test("nothing clips the rail's labels any more", () => {
  assert.doesNotMatch(STYLES, /\.rail \.lbl \{/);
});

// The drawer is the one place motion carries meaning — it comes from the edge it lives on,
// which says it was always there rather than that it appeared. Guarded like every other
// transition in this sheet, and the visibility delay is what lets the slide be seen at all.
test("the drawer slides, behind the reduced-motion guard", () => {
  assert.match(STYLES, /\.rail \{ transition: transform \.22s ease, visibility 0s linear \.22s; \}/);
  assert.match(STYLES, /#nav-open:checked ~ \.rail \{ transition: transform \.22s ease, visibility 0s; \}/);
  const guard = STYLES.slice(0, STYLES.indexOf(".rail { transition: transform"));
  assert.match(guard.slice(-260), /@media \(prefers-reduced-motion: no-preference\)/);
});

// ---------- the dependency map ----------

// An arrow is nothing but its stroke, and in the light scheme a node box is nothing but its
// outline (--surface and --surface-raised are the same white, so the box has no fill contrast
// at all). Both were drawn in --border-strong — a BORDER token — at 1.65:1, against the 3:1 a
// load-bearing graphic needs. Every mark on that map carrying STATE already cleared it.
test("the map's structural strokes come off the mark ramp, not a border token", () => {
  for (const sel of ["\\.topo-box", "\\.topo-edge", "\\.topo-edge-soft", "\\.topo-arrow"]) {
    const rule = STYLES.match(new RegExp(`^${sel} \\{[^}]*\\}`, "m"))?.[0] ?? "";
    assert.ok(rule, `no ${sel} rule`);
    assert.match(rule, /var\(--mark-line\)/, `${sel} still draws in a border token`);
    assert.doesNotMatch(rule, /var\(--border-strong\)/);
  }
  assert.match(STYLES, /--mark-line: #7d8797/);
});

// The cluster outline and the dot grid stay where they are, and that is a decision rather than
// an oversight: a cluster groups boxes that position and a band label already group, and a dot
// grid is a texture. Neither carries information, so neither has a contrast bar to clear.
test("the map's decorative lines are left alone", () => {
  assert.match(STYLES, /\.topo-cluster \{[^}]*stroke: var\(--border\)/);
  assert.match(STYLES, /\.topo-dot \{ fill: var\(--border\); \}/);
});

// The text lives inside the SVG, so shrinking the drawing shrinks the type: at 390px the
// 11.5-unit labels rendered near 4.9px. The floor comes from the drawing itself so it cannot
// drift from the layout that produced it.
test("the map never draws smaller than it was laid out for", () => {
  const html = topologyPage(baseTopology, NONCE);
  assert.match(html, /class="topo" style="--topo-w:\d+px"/);
  assert.match(STYLES, /\.topo-view \.topo \{ width: 100%; min-width: var\(--topo-w, \d+px\); \}/);
  assert.match(STYLES, /\.topo-view \{[^}]*overflow-x: auto/, "the floor is only safe if it scrolls");
});

// The vocabulary was never stated: an amber dashed box meant "not configured" and a teal edge
// meant "over SQS via llm-worker" — the one fact the diagram exists to make obvious — and a
// reader had to already know.
test("the map carries a key, drawn with the same classes as the map", () => {
  const t: Topology = {
    ...baseTopology,
    outbound: [{ label: "SQS", detail: "q", meta: "", configured: false }],
    backends: [{ name: "b", kind: "private-llm", model: "m", route: "light", endpoint: "sqs://x", viaWorker: true }],
  };
  const html = topologyPage(t, NONCE);
  assert.match(html, /<ul class="topo-legend">/);
  // the swatches ARE fragments of the drawing, so a restyle cannot leave the key behind
  assert.match(html, /class="topo-box topo-self"/);
  // A <rect>, not a line — the diagram marks a worker-reached backend by the stroke of its
  // chip, and a line carrying .topo-edge as well came out grey at equal specificity. The
  // swatch has to be the same ELEMENT as the thing it stands for, not merely the same classes.
  assert.match(html, /<rect[^>]*class="topo-box topo-backend topo-backend-worker"/);
  assert.doesNotMatch(html, /<path[^>]*topo-backend-worker/);
  assert.match(html, /class="topo-box topo-off"/);
  assert.match(html, /reached over SQS via llm-worker/);
  assert.match(html, /not configured/);
});

// A key that explains a colour which is not on screen is a key that has to be read past.
test("the key only explains what was actually drawn", () => {
  const clean: Topology = {
    ...baseTopology,
    inbound: [{ label: "Slack", detail: "socket", meta: "", configured: true }],
    backends: [{ name: "b", kind: "claude", model: "m", route: "heavy", endpoint: "api", viaWorker: false }],
  };
  const html = topologyPage(clean, NONCE);
  const legend = html.slice(html.indexOf(`<ul class="topo-legend">`), html.indexOf("</ul>", html.indexOf(`<ul class="topo-legend">`)));
  assert.doesNotMatch(legend, /topo-off/, "nothing is unconfigured");
  assert.doesNotMatch(legend, /topo-backend-worker/, "no backend takes the worker");
  // the agent is always drawn, and the affordance always applies
  assert.match(legend, /topo-self/);
  assert.match(legend, /Every box links to its row below/);
});

// The live toolbar carries a "Drag to pan" hint and is hidden until the script runs, so
// without one nothing announced that the boxes go anywhere.
test("the script-free page states the affordance the toolbar would have", () => {
  const html = topologyPage(baseTopology, NONCE);
  assert.match(html, /<li class="topo-legend-note">Every box links to its row below\.<\/li>/);
});

// The floor that keeps the type legible is also what makes the frame clip, and on a platform
// with overlay scrollbars nothing on screen says the rest is one drag away. Revealed by CSS
// rather than decided in the renderer: whether it overflows is a question about the CONTENT
// COLUMN's width, and at the same viewport that column is 13.5rem narrower with a rail beside
// it than without — only a container query knows.
test("a clipped map says it can be dragged", () => {
  const html = topologyPage(baseTopology, NONCE);
  assert.match(html, /<li class="topo-scroll-hint">Drag the map sideways to see the rest\.<\/li>/);
  assert.match(STYLES, /\.topo-scroll-hint \{ display: none; \}/);
  assert.match(STYLES, /@container page \(max-width: 53rem\) \{[\s\S]*?\.topo-scroll-hint \{ display: flex; \}/);
});

// Expanding a family used to move the count column sideways under the reader's pointer, on the
// very click that was supposed to reveal something. Auto layout sizes columns from content, so
// inserting a list of tool names re-divided the whole table.
test("opening a tool family cannot move the count column", () => {
  const t: Topology = {
    ...baseTopology,
    capabilities: [
      { name: "kubernetes", tools: [{ name: "k8s_restart_deployment", write: true }, { name: "k8s_list_pods", write: false }] },
      { name: "loki", tools: [{ name: "loki_query", write: false }] },
    ],
  };
  const html = topologyPage(t, NONCE);
  // the hook the rule hangs off — the only table on the dashboard that carries a class
  assert.match(html, /<table class="caps">/);
  assert.match(STYLES, /table\.caps \{ table-layout: fixed; \}/);
  // fixed layout takes its widths from the header row, so that is where the width is stated
  assert.match(STYLES, /table\.caps th:last-child, table\.caps td:last-child \{ width: 6rem; \}/);
});

// The exception has to stay narrow. Every other table wants the auto algorithm: it divides the
// frame in proportion to what each column could use, which is what balances the RCA's Evidence
// table at roughly 65/35 without a number being written down anywhere.
test("no other table is laid out fixed", () => {
  assert.equal([...STYLES.matchAll(/table-layout: fixed/g)].length, 1);
  assert.doesNotMatch(STYLES, /^table \{[^}]*table-layout/m, "a blanket rule would flatten Evidence");
});

// The disclosure lives in exactly one table, and the skills table's deliberate absence of one
// is what keeps that true — a <details> there would expand a row and push every skill below it
// off the screen, which is the reason skillPage exists.
test("the MCP tools table is the only table with a disclosure in a cell", () => {
  assert.doesNotMatch(bodyOf(contextPage(CTX)), /<details/);
  // and the one that does have it is the one that carries the class. baseTopology has no
  // capabilities at all — it renders the empty state, not a table — so this needs its own.
  const t: Topology = { ...baseTopology, capabilities: [{ name: "loki", tools: [{ name: "loki_query", write: false }] }] };
  const caps = bodyOf(topologyPage(t, NONCE));
  assert.match(caps, /<table class="caps">[\s\S]*<details>/);
  assert.equal([...caps.matchAll(/<table class="caps">/g)].length, 1, "one table carries the class");
  assert.equal([...caps.matchAll(/<details>/g)].length, 1, "one disclosure, in that table");
});

// ---------- the core prompt ----------

// The page showed the core prompt's SIZE while showing every skill's text in full — the
// conditional half rendered, the unconditional and larger half hidden.
test("the context page leads to the prompt instead of only measuring it", () => {
  const html = contextPage(CTX);
  assert.match(html, /<a class="standalone" href="\/prompt">Read the prompt →<\/a>/);
  // the numbers stay: the link is a way in, not a replacement for the summary
  assert.match(html, /267 lines/);
});

// On its own page for the reason skillPage exists: 24,000 characters inline would bury the
// budget table under four screens of prompt.
test("the prompt page renders the text the process is holding", () => {
  const html = promptPage(CTX);
  assert.match(html, /<pre class="skill-body">You are an expert DevOps AI Agent\./);
  assert.match(html, /prompts\/system\.md/);
  assert.match(html, /267 lines · 24,100 chars · about 8,034 tokens/);
  // the rail keeps Context lit, the way a skill page does
  assert.match(html, /<a href="\/context" aria-current="page">/);
});

// The distinction the page exists for. buildStaticSystemPrompt reads the file once and caches
// it, and the file is editable without a rebuild — so git, the pod's disk and this string can
// all disagree, and only this one decides what the agent says.
test("the prompt page says the text is the running copy, not the file", () => {
  const html = promptPage(CTX);
  assert.match(html, /this process is holding/);
  assert.match(html, /read once at boot and cached/);
});

// It is file content rather than LLM output, which is a weaker threat — and it goes through
// esc() anyway, because the rule in this file has no exceptions.
test("the prompt body is escaped", () => {
  const hostile: ContextView = { ...CTX, core: { ...CTX.core, body: `<img src=x onerror="alert(1)">` } };
  const html = promptPage(hostile);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// A skill's name is a filename and the skill route matches one segment under /context, so a
// reserved word there could one day be shadowed by a file someone adds to prompts/skills. A
// route that cannot collide beats a guard that has to remember to.
test("a skill called 'prompt' cannot shadow the prompt page", () => {
  assert.deepEqual(matchRoute("/prompt"), { kind: "prompt" });
  assert.deepEqual(matchRoute("/context/prompt"), { kind: "skill", name: "prompt" });
});
