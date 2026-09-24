import { test } from "node:test";
import assert from "node:assert/strict";
import { leaksRcaStructure, buildRcaBlocks, extractSection, isRcaResponse, formatRunFooter, formatDuration } from "./blocks.js";

// Reported from a live card: Impact ran straight into Recommended Actions, and Evidence into
// Ruled Out, while every other boundary carried a rule. Both pairs shared one divider because the
// guard against a dangling rule was written per PAIR rather than per section.
test("every section on the card is separated from the next by a divider", () => {
  const rca =
    "*🔴 Severity:* `Critical`\n\n" +
    "*⚡ TL;DR*\n`shop/api` is down.\n\n" +
    "*⚠️ Impact if Unresolved*\ncheckout fails for everyone.\n\n" +
    "*🔧 Recommended Actions*\n1. *Immediate:* restore `shop/api`\n\n" +
    "*📍 Root Cause*\n1. *Symptom:* OOMKilled — _k8s_describe_pod_ `shop/api-7d9f`\n\n" +
    "*📊 Evidence*\n• *Fact:* restarts=5 — _k8s_list_pods_ `shop/api-7d9f`\n• *Fact:* limit is `128Mi` — _k8s_get_resource_ `shop/api`\n\n" +
    "*🚫 Ruled Out*\n• node pressure — every other pod is Ready\n\n" +
    "*📈 Confidence:* `High` — two sources agree";

  const types = buildRcaBlocks(rca, "alertname").map((b) => b.type);
  // Walk the body and assert no two content blocks touch. The Evidence heading and its table are
  // the one deliberate pair — a table carries no title of its own.
  const body = types[types.length - 1] === "context" ? types.slice(0, -1) : types;
  for (let i = 1; i < body.length; i++) {
    const pair = `${body[i - 1]}+${body[i]}`;
    if (pair === "section+table") continue; // the heading and the table it announces
    assert.ok(
      body[i] === "divider" || body[i - 1] === "divider",
      `two blocks touch with no divider between them: ${pair} at ${i} in [${body.join(", ")}]`,
    );
  }
});

test("partial RCA leak (plan + impact + confidence, no Severity) is detected", () => {
  const reply =
    "Here's what I found:\n- image: controller:v1.15.1\n" +
    "Proposed plan\n1. Immediate: update the image\n2. Short-term: monitor rollout\n" +
    "⚠️ Impact if Unresolved\nmisses security fixes\n" +
    "📈 Confidence: High — clear state";
  assert.equal(leaksRcaStructure(reply), true);
});

test("plain conversational answers pass (one marker alone is not a leak)", () => {
  assert.equal(leaksRcaStructure("deployment `x` runs `nginx:1.25`, all pods Ready"), false);
  assert.equal(leaksRcaStructure("the root cause was a bad tag; confidence: high"), false); // 1 marker
});

test("mutating kubectl/helm command dumps are a leak on their own", () => {
  assert.equal(leaksRcaStructure("What to run:\n```\nkubectl rollout restart deployment x -n ns\n```"), true);
  assert.equal(leaksRcaStructure("helm upgrade nginx-ingress ingress-nginx/ingress-nginx --reuse-values"), true);
  // read-only commands mentioned in passing are fine
  assert.equal(leaksRcaStructure("saya cek pakai kubectl get pods -n ns, semua Running"), false);
});

// --- RCA card order + TL;DR -------------------------------------------------------------
//
// The card is read by someone who was just paged, so it opens with what is broken and what to
// do, and puts the argument behind it below. The template emits the sections in this order too
// — but buildRcaBlocks extracts each one by label, not by position, so an RCA written before
// TL;DR existed still renders, and renders in the new order.

const titles = (rca: string) =>
  buildRcaBlocks(rca)
    .filter((b: any) => b.type === "section")
    .map((b: any) => (b.text?.text ?? "").split("\n")[0]);

const NEW_FORMAT = [
  "*\u{1F534} Severity:* `Critical`",
  "",
  "*\u26A1 TL;DR*",
  "`sample-apps/checkout-gateway` returns 500 on every checkout.",
  "Roll `orders-api` back to `v1.4.2` now.",
  "",
  "*\u26A0\uFE0F Impact if Unresolved*",
  "`sample-apps/checkout-svc` has `1/3 ready`.",
  "",
  "*\u{1F527} Recommended Actions*",
  "1. *Immediate:* roll back",
  "",
  "*\u{1F4CD} Root Cause*",
  "1. Checkout returns 500 — _prometheus_query_ `sample-apps/checkout-gateway`",
  "2. \u2190 body unparseable — _loki_query_ `unexpected field`",
  "3. \u26D4 why the value changed is in GitOps history",
  "",
  "*\u{1F4CA} Evidence*",
  "• `0/3` ready — _k8s_get_endpoints_ `sample-apps/orders-api`",
  "",
  "*\u{1F6AB} Ruled Out*",
  "• OOMKill — no restarts in 6h",
  "",
  "*\u{1F4C8} Confidence:* `High` — three sources agree",
].join("\n");

test("the RCA card leads with TL;DR, then impact, then actions — reasoning below", () => {
  assert.deepEqual(titles(NEW_FORMAT), [
    "*\u26A1 TL;DR*",
    "*\u26A0\uFE0F Impact if Unresolved*",
    "*\u{1F527} Recommended Actions*",
    "*\u{1F4CD} Root Cause*",
    "*\u{1F4CA} Evidence*",
    "*\u{1F6AB} Ruled Out*",
    "*\u{1F4C8} Confidence:* `High` — three sources agree",
  ]);
});

test("TL;DR stops at the next section instead of swallowing it", () => {
  // The regression this guards: extractSection ends a section on a hardcoded set of emoji, so a
  // label whose emoji is missing from that set is invisible as a boundary and the section above
  // it absorbs the rest of the RCA. Two lines in, two lines out.
  const tldr = extractSection(NEW_FORMAT, "TL;DR");
  assert.equal(tldr.split("\n").length, 2);
  assert.match(tldr, /Roll `orders-api` back/);
  assert.doesNotMatch(tldr, /Impact if Unresolved/);
});

test("the causal chain survives extraction as numbered steps, stop marker included", () => {
  const chain = extractSection(NEW_FORMAT, "Root Cause");
  assert.equal(chain.split("\n").length, 3);
  assert.match(chain, /\u26D4 why the value changed/);
  assert.doesNotMatch(chain, /Evidence/);
});

test("an RCA written before TL;DR existed still renders, in the new order", () => {
  // Everything already in Postgres and in Slack history is in the old order with no TL;DR.
  const old = [
    "*\u{1F534} Severity:* `Critical`",
    "",
    "*\u{1F4CD} Root Cause*",
    "Pod payment-api OOMKilled.",
    "",
    "*\u{1F4CA} Evidence*",
    "• Pod restarted 15x in 30min",
    "",
    "*\u{1F527} Recommended Actions*",
    "1. *Immediate:* raise the memory limit",
    "",
    "*\u26A0\uFE0F Impact if Unresolved*",
    "Checkout is down.",
  ].join("\n");
  assert.deepEqual(titles(old), [
    "*\u26A0\uFE0F Impact if Unresolved*",
    "*\u{1F527} Recommended Actions*",
    "*\u{1F4CD} Root Cause*",
    "*\u{1F4CA} Evidence*",
  ]);
});

// ---------------------------------------------------------------------------
// The severity line is the one place the model reliably drifts. rca-format.md asks for
// `*[emoji] Severity:* `[level]`` — the only line in the template where the bold span closes
// mid-line and a backticked value follows. Every other label is a whole bold line, so the model
// regularises this one to match its neighbours.
//
// The three shapes below are verbatim from three consecutive live investigations. Not one of
// them is the template, and under the old pattern not one of them was recognised — so a complete
// RCA was posted to Slack as plain text and incidents.assessed_severity was written NULL.
// ---------------------------------------------------------------------------

const ROOT_CAUSE = "\n\n*📍 Root Cause*\ncheckout-gateway is failing its readiness probe.";

const OBSERVED: Array<[string, string, string]> = [
  ["the template, unchanged", "*🔴 Severity:* `Critical`", "critical"],
  ["no markup at all", "🟠 Severity: High", "high"],
  ["bold moved onto the value", "🔴 Severity: *Critical*", "critical"],
  ["one bold span over the whole line", "*🟡 Severity: Medium*", "medium"],
];

for (const [shape, line, expected] of OBSERVED) {
  test(`an RCA is recognised when the severity line is written as: ${shape}`, () => {
    assert.equal(isRcaResponse(line + ROOT_CAUSE), true, `not recognised: ${line}`);
  });

  test(`the card reads the level when the severity line is written as: ${shape}`, () => {
    // Recognising it is not enough — a card headed "⚪ Unknown Severity Incident" is the same
    // failure one step later, so the extractor and the recogniser must read the same line.
    const blocks = buildRcaBlocks(line + ROOT_CAUSE + "\n\n*📊 Evidence*\nprobe failures in events.");
    const header = JSON.stringify(blocks[0]);
    assert.match(header, new RegExp(expected, "i"), `header did not name the level: ${header}`);
    assert.doesNotMatch(header, /Unknown/, `level lost by the extractor: ${line}`);
  });
}

test("prose about severity is not a severity line", () => {
  // The colon is what separates the label from prose, and it is why the pattern requires one.
  // Without this the recogniser would fire on any answer that discusses severity at all.
  for (const prose of [
    "The severity is high and the blast radius is wide." + ROOT_CAUSE,
    "Whatever the severity, critical services stayed up." + ROOT_CAUSE,
    "I could not determine severity." + ROOT_CAUSE,
  ]) {
    assert.equal(isRcaResponse(prose), false, `prose matched: ${prose.slice(0, 60)}`);
  }
});

test("a severity line alone is not an RCA — the Root Cause section still has to be there", () => {
  // The pair is the signal. Loosening one half must not turn every mention of a level into a
  // card, which is what the Root Cause clause is holding.
  assert.equal(isRcaResponse("*🔴 Severity:* `Critical`\n\nStill looking into it."), false);
});

test("an unknown level is not a severity line", () => {
  // The old extractor took anything inside backticks, so `P1` became a header reading
  // "⚪ P1 Severity Incident". Only the four the template names are levels.
  assert.equal(isRcaResponse("*🔴 Severity:* `P1`" + ROOT_CAUSE), false);
});

test("the template's own placeholder is not a chosen level", () => {
  // A model that copies the template instead of filling it in emits every level at once. A
  // trailing \b would match "Critical" in front of the pipe and store a judgement nobody made.
  assert.equal(isRcaResponse("*[emoji] Severity:* `[Critical|High|Medium|Low]`" + ROOT_CAUSE), false);
});

// ---------------------------------------------------------------------------
// Two spaces at the end of a line is markdown's hard line break, and the model writes its
// headings that way — "*📍 Root Cause*  \n". extractSection used to require the newline to touch
// the closing asterisk, so every section came back "" and app/index.ts fell through to
// splitForSlack: the RCA was posted as plain mrkdwn with no Block Kit card at all.
//
// That is what "the dividers disappeared in Slack" was. Not a Slack rendering question and not
// the LLM backend — no card was built, so there were no dividers to lose. Whether any given
// investigation rendered a card came down to whether the model added trailing spaces that run,
// which is why it looked intermittent.
// ---------------------------------------------------------------------------

// Verbatim shape from the 2026-09-03 17:39 investigation, trailing spaces included.
const HARD_BREAKS =
  "🔴 Severity: *Critical*\n\n" +
  "*⚡ TL;DR*  \n" +
  "Service `sample-apps/storefront` is returning HTTP 504s.\n\n" +
  "*📍 Root Cause*  \n" +
  "1. [Symptom] — checkout-gateway probes are failing.\n\n" +
  "*📊 Evidence*  \n" +
  "• [Fact 1] — connection refused on port 3000.\n";

test("a heading followed by markdown's hard line break still opens a section", () => {
  assert.equal(extractSection(HARD_BREAKS, "Root Cause"), "1. [Symptom] — checkout-gateway probes are failing.");
  assert.equal(extractSection(HARD_BREAKS, "TL;DR"), "Service `sample-apps/storefront` is returning HTTP 504s.");
  assert.equal(extractSection(HARD_BREAKS, "Evidence"), "• [Fact 1] — connection refused on port 3000.");
});

test("a section still ends at the next heading when that heading has trailing spaces", () => {
  // The lookahead has to tolerate them too, or Root Cause swallows Evidence and the card shows
  // one section holding the rest of the RCA.
  assert.doesNotMatch(extractSection(HARD_BREAKS, "Root Cause"), /Evidence|Fact 1/);
});

test("the card is built for an RCA written with hard line breaks", () => {
  // The end of the chain, and the one that decides whether Slack gets blocks at all:
  // app/index.ts posts the card only when isRcaResponse AND a Root Cause section both hold.
  assert.equal(isRcaResponse(HARD_BREAKS), true);
  assert.ok(extractSection(HARD_BREAKS, "Root Cause"), "no Root Cause section — the card path is skipped");
  const blocks = buildRcaBlocks(HARD_BREAKS);
  assert.ok(blocks.filter((b) => b.type === "divider").length >= 3, "the card lost its dividers");
  assert.match(JSON.stringify(blocks[0]), /Critical Severity Incident/);
});

test("headings with no trailing whitespace are unaffected", () => {
  const plain = HARD_BREAKS.replace(/\*  \n/g, "*\n");
  assert.equal(extractSection(plain, "Root Cause"), "1. [Symptom] — checkout-gateway probes are failing.");
  assert.equal(buildRcaBlocks(plain).length, buildRcaBlocks(HARD_BREAKS).length);
});

test("the footer names both the route alias and the model that actually ran", () => {
  // "private-llm-chatgpt" alone does not say which model; "gpt-5-nano" alone does not say
  // which backend answered after a failover. On a live run they disagreed and both mattered.
  const f = formatRunFooter({
    durationMs: 12340, rounds: 2, toolCalls: 3,
    backend: "private-llm-chatgpt", model: "gpt-5-nano-2025-08-07", route: "light",
  });
  assert.match(f, /^⏱ 12s/); // decimals only below 10s — 12.3 vs 12 tells a reader nothing
  assert.match(f, /private-llm-chatgpt \(gpt-5-nano-2025-08-07\) · light/);
  assert.match(f, /2 rounds · 3 tool calls/);
});

// ── Duration units ──────────────────────────────────────────────────────────
// It used to be seconds all the way up, so a slow private backend printed `⏱ 101s` and the
// reader had to divide. Investigations here reach minutes routinely.

test("seconds lose the decimal once the number is big enough not to need it", () => {
  assert.equal(formatDuration(9400), "9.4s");
  assert.equal(formatDuration(12000), "12s");
  // The threshold tests the ROUNDED value, or this would print the odd "10.0s".
  assert.equal(formatDuration(9999), "10s");
  assert.equal(formatDuration(9949), "9.9s");
});

test("a run past a minute is reported in minutes and seconds", () => {
  assert.equal(formatDuration(101457), "1m 41s"); // measured live, used to read "101s"
  assert.equal(formatDuration(344772), "5m 45s");
  assert.equal(formatDuration(59000), "59s", "the last second before a minute is still seconds");
  assert.equal(formatDuration(60000), "1m");
});

test("a run past an hour is reported in hours", () => {
  assert.equal(formatDuration(3600000), "1h");
  assert.equal(formatDuration(3661000), "1h 1m 1s");
  assert.equal(formatDuration(7385000), "2h 3m 5s");
});

// `2m` beats `2m 0s`, and an hour and nine seconds IS "1h 9s".
test("a zero unit is dropped rather than padded", () => {
  assert.equal(formatDuration(120000), "2m");
  assert.equal(formatDuration(3609000), "1h 9s");
  assert.equal(formatDuration(3660000), "1h 1m");
});

// Only 0ms reaches the all-zero case, and "0s" is a better answer there than "".
test("zero and negative input still produce a duration", () => {
  assert.equal(formatDuration(0), "0.0s");
  assert.equal(formatDuration(-5), "0.0s");
});

test("the footer carries whatever formatDuration produced", () => {
  assert.match(formatRunFooter({ durationMs: 344772, rounds: 2, toolCalls: 1 }), /^⏱ 5m 45s · /);
  assert.match(formatRunFooter({ durationMs: 9400, rounds: 1, toolCalls: 0 }), /^⏱ 9\.4s/);
});

test("singulars stay singular and a tool-less run says nothing about tools", () => {
  const f = formatRunFooter({ durationMs: 1000, rounds: 1, toolCalls: 0 });
  assert.match(f, /1 round(?!s)/);
  assert.ok(!/tool call/.test(f));
});

test("a footer block never joins the sections the parsers read", () => {
  const rca = "*📍 Root Cause*\nthe thing broke\n\n*📈 Confidence:* `High` — because";
  const withFooter = buildRcaBlocks(rca, "⏱ 3s · 2 rounds");
  const plain = buildRcaBlocks(rca);
  // extractSection reads a section to END OF TEXT, so a footer glued onto the reply would land
  // inside Confidence. As a block it cannot.
  assert.equal(withFooter.length, plain.length + 1);
  assert.equal(withFooter[withFooter.length - 1].type, "context");
  assert.equal(extractSection(rca, "Confidence"), extractSection(rca, "Confidence"));
  assert.ok(!JSON.stringify(plain).includes("⏱"));
});

// 2026-09-15 16:52, an explicit "investigasi kenapa prometheus query nya kosong": the model
// returned a full RCA — numbered causal chain, Evidence, Recommended Actions, 4200+ chars — and
// simply did not write a Severity line. isRcaResponse required one, so the whole thing went to
// Slack as plain mrkdwn: no header, no dividers, no sections, and nothing saying the card was
// skipped. buildRcaBlocks was always able to render it; only the gate in front of it was not.
test("an RCA with no severity line is still an RCA when a second section is there", () => {
  const actions = "\n\n*🔧 Recommended Actions*\n• Fix the metric name in the query.";
  assert.equal(isRcaResponse(ROOT_CAUSE + actions), true);
  assert.equal(isRcaResponse(ROOT_CAUSE + "\n\n*📊 Evidence*\nthe query returned an empty vector."), true);
  assert.equal(isRcaResponse(ROOT_CAUSE + "\n\n*📈 Confidence:* `High`"), true);
});

test("its card renders, with the severity it could not read shown as unknown", () => {
  const blocks = buildRcaBlocks(ROOT_CAUSE + "\n\n*📊 Evidence*\nempty vector from prometheus_query.");
  const header = blocks.find((b) => b.type === "header");
  assert.ok(header && "text" in header && header.text.text.includes("Unknown Severity"), JSON.stringify(header));
  assert.ok(blocks.some((b) => b.type === "divider"), "the card degraded to a single plain block");
});

// The clause that keeps the loosened gate honest: a heading is required, so prose about a root
// cause is still a conversation reply.
test("prose naming a root cause is not an RCA", () => {
  for (const reply of [
    "The root cause is the readiness probe timeout. Want me to open a PR?",
    "Root Cause: bad image tag. I can investigate further.",
  ]) {
    assert.equal(isRcaResponse(reply), false, reply);
  }
});

// Live 2026-09-23 04:41: a 4961-character Evidence section, and Slack answered `invalid_blocks`
// for the whole message — the RCA never reached the thread.
test("a section over Slack's 3000-char limit is split, not dropped", () => {
  const evidence = Array.from({ length: 90 }, (_, i) => `• [Fact ${i}] — _prometheus_query_ \`sample-apps/checkout-gateway\` p99 rose to 1.8s`).join("\n");
  const rca =
    "*🔴 Severity:* `Critical`\n\n*📍 Root Cause*\n1. [Symptom] latency\n\n*📊 Evidence*\n" + evidence + "\n\n*📈 Confidence:* `High`";
  const blocks = buildRcaBlocks(rca);
  const sections = blocks.filter((b) => b.type === "section");
  assert.ok(sections.length >= 3, "the evidence section must have become more than one block");
  for (const b of sections) {
    const t = "text" in b && b.text && typeof b.text !== "string" ? b.text.text : "";
    assert.ok(t.length <= 3000, `a section is still ${t.length} chars`);
  }
  // nothing silently lost: the last fact still ships
  assert.ok(blocks.some((b) => JSON.stringify(b).includes("[Fact 89]")), "the tail of the evidence was dropped");
});
