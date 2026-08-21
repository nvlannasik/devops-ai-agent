import { test } from "node:test";
import assert from "node:assert/strict";
import { detailPage, listPage, loginPage, overviewPage, errorPage, layout, pageWindow, topologyPage, contextPage, skillPage } from "./views.js";
import { PAGE_SIZE, parseFilters } from "./filters.js";
import { STYLES } from "./styles.js";
import type { IncidentDetail, IncidentPage, IncidentRow, Overview, Tokens } from "./queries.js";
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
  assert.match(html, /<table><thead><tr><th>Family<\/th>/, "the capability table stays a table at every width");

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
const shelvesOf = (html: string): string[] =>
  html
    .split(/<dl class="stats[^"]*">/)
    .slice(1)
    .map((s) => s.slice(0, s.indexOf("</dl>")));

test("every stat shelf holds four figures, and a shelf's sub-lines are all or none", () => {
  const pages = [
    overviewPage({ ...emptyOverview, tokens }, []),
    detailPage({ incident: { ...row, rca: null, channel: null, thread_ts: null }, remediations: [], feedback: [] }),
  ];
  const shelves = pages.flatMap(shelvesOf);
  assert.equal(shelves.length, 3, "the state panel, the token totals, the incident fact bar");
  for (const shelf of shelves) {
    const stats = shelf.split(`<div class="stat"`).slice(1);
    assert.equal(stats.length, 4);
    const withSub = stats.filter((s) => s.includes("<span>")).length;
    assert.ok(withSub === 0 || withSub === 4, `shelf mixes ${withSub} sub-lines into 4 figures`);
  }
});

// Open incidents are the one figure on the page that can be bad news, and the only one that
// carries a tone. A tone on every tile is a tone on none.
test("open incidents wear the severity spine, and only while any are open", () => {
  // Scoped to the shelf: the stylesheet is inlined into every page and names the tones too.
  const shelf = (html: string): string =>
    html.slice(html.indexOf(`<dl class="stats">`), html.indexOf("</dl>"));

  const busy = shelf(overviewPage({ ...emptyOverview, totalIncidents: 10, resolvedIncidents: 7 }, []));
  assert.match(busy, /<div class="stat" data-tone="critical"><dt>[\s\S]*?Open<\/dt><dd>3/);
  assert.equal(busy.match(/data-tone=/g)?.length, 1, "nothing else on the shelf is toned");

  const quiet = shelf(overviewPage({ ...emptyOverview, totalIncidents: 10, resolvedIncidents: 10 }, []));
  assert.match(quiet, /<div class="stat"><dt>[\s\S]*?Open<\/dt><dd>0/, "no tone when nothing is open");
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
    /Total tokens<\/dt><dd>1,293,199<span>input \+ output over 412 calls<\/span>/,
    "input + output, thousands-separated, over the call count"
  );
  assert.match(html, /Cache reads<\/dt><dd>950,004<span>12,003 written<\/span>/);
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
  assert.match(html, /data-label="Alert">Kube<wbr>Pod<wbr>Crash<wbr>Looping</);
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
  assert.equal(icons.length, 5, "four destinations and the sign-out button");
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
  assert.match(html, /<dt><svg class="ico"[\s\S]*?<\/svg>Total tokens<\/dt>/);
  assert.doesNotMatch(html, /&lt;svg/, "the glyph is markup, not escaped source");
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
test("nothing in the top bar gives way except the brand", () => {
  for (const sel of [String.raw`\.rail nav`, String.raw`form\.signout`]) {
    assert.match(STYLES, new RegExp(`${sel} \\{[^}]*flex: 0 0 auto`), `${sel} can be squeezed into an overflow`);
  }
  const brand = STYLES.match(/^\.rail \.brand \{([^}]*)\}/m);
  assert.ok(brand, "no .brand rule to check");
  assert.match(brand[1], /min-width: 0/);
  assert.match(brand[1], /text-overflow: ellipsis/);
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
  core: { lines: 267, chars: 24_100, tokens: 8_034 },
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
  assert.doesNotMatch(html, /<details/, "a body inside a row is what this page moved away from");
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
