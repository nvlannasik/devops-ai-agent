import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForSlack, toMrkdwn } from "./split.js";

test("short messages pass through untouched", () => {
  assert.deepEqual(splitForSlack("hello"), ["hello"]);
});

test("splits at newline boundaries under the limit", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(80)}`);
  const chunks = splitForSlack(lines.join("\n"), 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1010); // limit + closing fence slack
  // no line is cut in half: rejoining (minus fence rebalancing) preserves every line start
  for (const line of ["line 0 ", "line 50 ", "line 99 "]) {
    assert.ok(chunks.some((c) => c.includes(line)));
  }
});

test("re-balances code fences across the split", () => {
  const text = "intro\n```\n" + Array.from({ length: 60 }, (_, i) => `log line ${i}`).join("\n") + "\n```\ndone";
  const chunks = splitForSlack(text, 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const fences = (chunk.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `chunk has unbalanced fences:\n${chunk}`);
  }
  // continuation chunks that carry code start with a reopened fence
  assert.ok(chunks[1].startsWith("```"));
});

test("toMrkdwn converts **bold** to *bold* outside code fences only", () => {
  assert.equal(toMrkdwn("status **replicas=2** ok"), "status *replicas=2* ok");
  const fenced = "before **x**\n```\nkeep **raw** here\n```\nafter **y**";
  assert.equal(toMrkdwn(fenced), "before *x*\n```\nkeep **raw** here\n```\nafter *y*");
  assert.equal(toMrkdwn("already *bold* untouched"), "already *bold* untouched");
});

test("splitForSlack applies the mrkdwn conversion", () => {
  assert.deepEqual(splitForSlack("**bold**"), ["*bold*"]);
});

// ── Markdown headings ────────────────────────────────────────────────────────
// Slack has no headings at all, so `### Text` reaches the reader as three hashes. Observed
// 2026-09-16 in a live conversation thread, three times in one reply. A regression this repo
// caused itself: the syntax rules lived in rca-format.md, which was `when: always` and so rode
// along on every casual mention by accident until the mode tag scoped it to alert/investigation.

test("markdown headings become bold lines, at every level", () => {
  assert.equal(toMrkdwn("# Ringkasan"), "*Ringkasan*");
  assert.equal(toMrkdwn("### Detail ConfigMap"), "*Detail ConfigMap*");
  assert.equal(toMrkdwn("###### deep"), "*deep*");
  assert.equal(toMrkdwn("## Closed ##"), "*Closed*", "the trailing hashes of setext style survived");
  assert.equal(toMrkdwn("  ## indented"), "*indented*");
});

test("headings convert in the middle of a reply, leaving the prose alone", () => {
  const out = toMrkdwn("Ada 3 ConfigMap.\n\n### Daftar\n`order-configmap` di `default`.");
  assert.equal(out, "Ada 3 ConfigMap.\n\n*Daftar*\n`order-configmap` di `default`.");
});

// The two ways a `#` is NOT a heading. Both appear in real DevOps prose.
test("a hash that is not a heading is left exactly as it was", () => {
  assert.equal(toMrkdwn("the pod is #1 in the queue"), "the pod is #1 in the queue");
  assert.equal(toMrkdwn("#1 priority"), "#1 priority", "no space after the hash = not a heading");
  assert.equal(toMrkdwn("see issue #42 for context"), "see issue #42 for context");
  assert.equal(toMrkdwn("#"), "#", "a bare hash has no title to bold");
  assert.equal(toMrkdwn("####"), "####");
});

// The whole reason both conversions are fence-aware: a YAML comment or a shell line inside a
// code block is content, not markup.
test("headings inside a code fence are content and stay untouched", () => {
  const text = "Manifest:\n```\n# managed by flux\napiVersion: v1\n```\n### Catatan\nselesai.";
  const out = toMrkdwn(text);
  assert.ok(out.includes("# managed by flux"), "a YAML comment was rewritten as bold");
  assert.ok(out.includes("*Catatan*"), "the heading outside the fence was not converted");
});

test("bold conversion still works, and both run on the same text", () => {
  assert.equal(toMrkdwn("### Hasil\n**order-configmap** aman"), "*Hasil*\n*order-configmap* aman");
});

// `*a *b* c*` closes the span early in Slack and the rest of the line loses its formatting.
test("asterisks inside a heading title are dropped, not nested", () => {
  assert.equal(toMrkdwn("## The **important** part"), "*The important part*");
});

test("splitForSlack applies the heading conversion too", () => {
  assert.ok(splitForSlack("### Ringkasan\nisi")[0].startsWith("*Ringkasan*"));
});
