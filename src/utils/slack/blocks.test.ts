import { test } from "node:test";
import assert from "node:assert/strict";
import { leaksRcaStructure, buildRcaBlocks, extractSection, isRcaResponse } from "./blocks.js";

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
