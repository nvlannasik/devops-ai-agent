import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineMrkdwn, parseRca, renderRca } from "./rca.js";

// The shape prompts/system.md asks the model for, verbatim down to the emoji and the em
// dashes ("labels must match precisely for rendering"). The structural assertions below all
// key off this one fixture, so a prompt edit that renames a section surfaces here as a red
// test rather than as a page that quietly stops tabulating.
const TEMPLATE = [
  "*🔴 Severity:* `Critical`",
  "",
  "*📍 Root Cause*",
  "The api-gateway deployment in `prod` was OOMKilled 14 times in the last hour: its memory",
  "limit of 256Mi sits below the steady-state working set of ~380Mi after the v2.4 rollout.",
  "",
  "*📊 Evidence*",
  "• Container restarted 14 times, reason OOMKilled — _k8s_list_pods_ `prod/api-gateway`",
  "• Working set peaked at 391Mi — _prometheus_query_ `prod/api-gateway`",
  "",
  "*🚫 Ruled Out*",
  "• Node memory pressure — no node reported MemoryPressure in the window",
  "• Bad image — the same digest ran for six days without a restart",
  "",
  "*🔧 Recommended Actions*",
  "1. *Immediate:* raise `resources.limits.memory` to 512Mi",
  "2. *Short-term:* alert at 80% of the limit",
  "3. *Long-term:* profile the v2.4 allocation path",
  "",
  "*⚠️ Impact if Unresolved*",
  "Requests fail with 502 for the duration of each restart cycle.",
  "",
  "*📈 Confidence:* `High` — three independent signals agree.",
].join("\n");

test("the template parses into its labelled fields and its sections, in order", () => {
  const rca = parseRca(TEMPLATE);
  assert.ok(rca, "the documented format must parse");
  // the emoji is Slack's signal, not the page's — the page already has headings
  assert.deepEqual(
    rca.fields.map((f) => f.label),
    ["Severity", "Confidence"]
  );
  assert.deepEqual(
    rca.sections.map((s) => s.title),
    ["Root Cause", "Evidence", "Ruled Out", "Recommended Actions", "Impact if Unresolved"]
  );
});

// `*🔴 Severity:*` is a field and `*📍 Root Cause*` is a heading, and the only thing that
// separates them is the colon immediately before the closing asterisk.
test("an argument stays prose; a set of facts becomes two columns", () => {
  const rca = parseRca(TEMPLATE)!;
  const byTitle = new Map(rca.sections.map((s) => [s.title, s.body]));
  assert.equal(byTitle.get("Root Cause")!.kind, "prose");
  assert.equal(byTitle.get("Impact if Unresolved")!.kind, "prose");

  const evidence = byTitle.get("Evidence")!;
  assert.equal(evidence.kind, "rows");
  if (evidence.kind !== "rows") return;
  assert.deepEqual(evidence.columns, ["Finding", "Source"]);
  assert.equal(evidence.rows.length, 2);
  // the em dash is the claim/source split, and only the first one in a line counts
  assert.equal(evidence.rows[0].left, "Container restarted 14 times, reason OOMKilled");
  assert.equal(evidence.rows[0].right, "_k8s_list_pods_ `prod/api-gateway`");
});

test("the ordered actions become horizon and action, not a numbered list of one blob", () => {
  const rca = parseRca(TEMPLATE)!;
  const actions = rca.sections.find((s) => s.title === "Recommended Actions")!.body;
  assert.equal(actions.kind, "rows");
  if (actions.kind !== "rows") return;
  assert.deepEqual(actions.columns, ["Horizon", "Action"]);
  assert.deepEqual(
    actions.rows.map((r) => r.left),
    ["Immediate", "Short-term", "Long-term"]
  );
  assert.equal(actions.rows[0].right, "raise `resources.limits.memory` to 512Mi");
});

// A section whose bullets carry no separator would otherwise render a table with a dead
// column — a header promising a source for every finding, and nothing underneath it.
test("bullets with nothing to split on stay a list rather than growing an empty column", () => {
  const rca = parseRca(
    [
      "*Root Cause*",
      "It broke.",
      "",
      "*Evidence*",
      "• the pod is not ready",
      "• the endpoint has no addresses",
    ].join("\n")
  )!;
  const evidence = rca.sections.find((s) => s.title === "Evidence")!.body;
  assert.equal(evidence.kind, "list");
  if (evidence.kind !== "list") return;
  assert.deepEqual(evidence.items, ["the pod is not ready", "the endpoint has no addresses"]);
});

// Models wrap long evidence lines. A continuation that lands nowhere is the kind of loss
// that stays invisible until the dropped half is the one that mattered.
test("a wrapped bullet keeps its continuation", () => {
  const rca = parseRca(
    [
      "*Root Cause*",
      "It broke.",
      "",
      "*Evidence*",
      "• The container was OOMKilled 14 times in the last hour — _k8s_list_pods_",
      "  `prod/api-gateway`",
      "• Second fact — _prometheus_query_",
    ].join("\n")
  )!;
  const evidence = rca.sections.find((s) => s.title === "Evidence")!.body;
  assert.equal(evidence.kind, "rows");
  if (evidence.kind !== "rows") return;
  assert.equal(evidence.rows.length, 2, "the continuation is not a third row");
  assert.equal(evidence.rows[0].right, "_k8s_list_pods_ `prod/api-gateway`");
});

// ---------- code fences ----------

const FENCED = [
  "*Root Cause*",
  "The gateway panicked on a nil pointer.",
  "",
  "*Evidence*",
  "```",
  "• not a bullet",
  "*not a heading*",
  "panic: runtime error: invalid memory address <nil>",
  "```",
].join("\n");

// Two titled sections is the parse threshold exactly, which is the point: if the fence
// leaked, `*not a heading*` would become a third.
test("a code fence is not scanned for headings or bullets", () => {
  const rca = parseRca(FENCED)!;
  assert.deepEqual(
    rca.sections.map((s) => s.title),
    ["Root Cause", "Evidence"]
  );
  const evidence = rca.sections[1].body;
  assert.equal(evidence.kind, "prose", "a section holding a stack trace is not tabulated");
  if (evidence.kind !== "prose") return;
  assert.equal(evidence.blocks.length, 1);
  assert.equal(evidence.blocks[0].code, true);
});

test("fenced text renders verbatim: no emphasis applied, every angle bracket escaped", () => {
  const html = renderRca(FENCED);
  assert.match(html, /<pre class="rca-code" translate="no"><code>/);
  assert.match(html, /panic: runtime error: invalid memory address &lt;nil&gt;/);
  // *not a heading* keeps its asterisks — inside a fence they are characters, not markup
  assert.match(html, /\*not a heading\*/);
  assert.doesNotMatch(html, /<strong>not a heading<\/strong>/);
});

// ---------- degrading ----------

// A model that ignores the format must lose its formatting, never its content. One
// whole-line bold run is a sentence someone emphasised, not a document with structure.
test("text that does not look like the template renders plainly instead of being restructured", () => {
  const raw = "The api-gateway pods are restarting.\n*This is the important part.*\nNothing else.";
  assert.equal(parseRca(raw), null);
  const html = renderRca(raw);
  assert.match(html, /<div class="prose"><div class="prose-text">/);
  assert.match(html, /\*This is the important part\.\*/, "the markers survive as characters");
  assert.match(html, /The api-gateway pods are restarting\./);
  assert.match(html, /Nothing else\./);
  assert.doesNotMatch(html, /<table/);
});

test("empty and whitespace-only analyses degrade rather than throw", () => {
  for (const raw of ["", "   \n\n  ", "\n"]) {
    assert.equal(parseRca(raw), null);
    assert.doesNotThrow(() => renderRca(raw));
  }
});

// ---------- security ----------

// THE test this file exists for. The RCA is model output on a page whose CSP grants no
// script-src at all; escaping is the first of those two locks and the only one this module
// owns. HOSTILE sits in every position the parser routes model text through — field label
// and value, prose, both halves of a table row, a list item, a code span, a code fence and
// a section heading — and each was mutation-checked: replacing that one esc() with String()
// turns this test red. The only esc() calls it does not pin are the two <th>s, which render
// the COLUMNS constant in this module rather than anything a model wrote.
const HOSTILE = `<img src=x onerror="alert(1)">`;

test("every parsed position escapes: heading, field, prose, row, list item, code, fence", () => {
  const html = renderRca(
    [
      // the label as well as the value: both halves of a field come from the model
      `*Severity ${HOSTILE}:* ${HOSTILE}`,
      "",
      "*Root Cause*",
      HOSTILE,
      "",
      "*Evidence*",
      `• ${HOSTILE} — ${HOSTILE}`,
      "",
      // a hostile heading has to keep a leading letter, or clean() strips the "<" for us
      // and the assertion passes for the wrong reason
      `*Ruled Out ${HOSTILE}*`,
      `• ${HOSTILE}`,
      `• a code span: \`${HOSTILE}\``,
      "",
      "*Impact if Unresolved*",
      "```",
      HOSTILE,
      "```",
    ].join("\n")
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  // the attribute quotes are gone too, so nothing can break out of one we opened
  assert.doesNotMatch(html, /onerror="alert/);
});

test("the degrade path escapes as thoroughly as the parsed one", () => {
  const html = renderRca(`${HOSTILE}\njust one line of prose`);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// esc() strips every `<` and `>` before a single tag is added, so the tag set in the output
// is provably this module's own. Asserted as a closed set: a new tag has to be added here
// deliberately, and cannot arrive from a model.
test("the rendered tag vocabulary is fixed and small", () => {
  const html = renderRca(TEMPLATE);
  const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
  const allowed = new Set([
    "div", "dl", "dt", "dd", "h3", "p", "ul", "li", "pre", "code", "strong", "em",
    "table", "thead", "tbody", "tr", "th", "td", "span",
  ]);
  for (const t of tags) assert.ok(allowed.has(t), `unexpected tag <${t}> in the RCA output`);
  assert.doesNotMatch(html, /<script|onerror=|javascript:/i);
});

// ---------- inline mrkdwn ----------

test("snake_case survives; the template's own _tool_name_ still italicises", () => {
  // k8s_list_pods must come out whole: no opener, because the underscore has a letter on
  // its left. The same identifier wrapped in markers is the form the prompt asks for.
  assert.equal(inlineMrkdwn("ran k8s_list_pods on prod"), "ran k8s_list_pods on prod");
  assert.equal(inlineMrkdwn("via _k8s_list_pods_ here"), "via <em>k8s_list_pods</em> here");
  assert.equal(inlineMrkdwn("via _k8s_list_pods_."), "via <em>k8s_list_pods</em>.");
});

test("a single asterisk is bold, as Slack means it, not a list marker", () => {
  assert.equal(inlineMrkdwn("*Immediate:* raise the limit"), "<strong>Immediate:</strong> raise the limit");
});

test("markup inside a code span is characters, not markup", () => {
  const html = inlineMrkdwn("run `kubectl get po -o jsonpath={.spec.containers[*].name}`");
  assert.match(html, /<code translate="no">/);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<em>/);
});

test("a code span escapes what it holds", () => {
  assert.equal(
    inlineMrkdwn("`<script>alert(1)</script>`"),
    `<code translate="no">&lt;script&gt;alert(1)&lt;/script&gt;</code>`
  );
});
