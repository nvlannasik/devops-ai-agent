import { test } from "node:test";
import assert from "node:assert/strict";
import { collectChanges, renderForModel, renderForSlack, RECENT_CHANGES_BLOCK, type ChangeTimeline } from "./index.js";

const NOW = new Date("2026-10-09T00:00:00Z");
const ALERT = new Date("2026-10-08T12:00:00Z");
const tool = (o: unknown) => async () => JSON.stringify(o);
const cluster = {
  namespace: "apps", window: { from: "x", to: "y" }, unread: [],
  changes: [
    { at: "2026-10-08T11:00:00Z", source: "rollout", kind: "spec-change", workload: "Deployment/orders-api", revision: "5", diff: [{ field: "api.env.TIMEOUT_MS", from: "2000", to: "50" }] },
    { at: "2026-10-08T11:30:00Z", source: "rollout", kind: "restart", workload: "Deployment/other", revision: "3" },
    { at: "2026-10-07T01:00:00Z", source: "config", kind: "config-updated", workload: "ConfigMap/old" },
  ],
  helmReleases: [{ name: "orders-api", namespace: "flux-app" }],
};
const commit = { sha: "abc1234def", at: "2026-10-08T10:55:00Z", author: "jdoe", message: "lower timeout <fast> & safe", url: "https://gh/c/abc", paths: ["p"] };

test("collectChanges: the window starts 24h before the alert; subjects sort first; commits joined", async () => {
  const seen: Record<string, unknown>[] = [];
  const t = await collectChanges(
    { callTool: async (_n, i) => { seen.push(i); return JSON.stringify(cluster); }, history: async () => ({ ok: true, op: "history", commits: [commit] }) },
    "apps", ALERT, ["orders-api-6b7c9-zx"], NOW
  );
  assert.deepEqual(seen[0], { namespace: "apps", sinceHours: 36 });
  assert.equal(t.window.from, "2026-10-07T12:00:00.000Z");
  assert.deepEqual(t.changes.map((c) => c.workload), ["Deployment/orders-api", "Deployment/other"], "subject first, outside the window dropped");
  assert.equal(t.commits[0].helmRelease, "orders-api");
  assert.deepEqual(t.unread, []);
});

test("collectChanges: an MCP error or a non-JSON answer is unread, never empty", async () => {
  const a = await collectChanges({ callTool: async () => { throw new Error("unknown tool"); } }, "apps", ALERT, [], NOW);
  assert.deepEqual(a.unread, ["cluster: unknown tool"]);
  const b = await collectChanges({ callTool: async () => "Error: forbidden" }, "apps", ALERT, [], NOW);
  assert.match(b.unread[0], /^cluster: Error: forbidden/);
  assert.match(renderForModel(b), /NOT read/);
  assert.doesNotMatch(renderForModel(b), /No changes recorded/);
});

test("collectChanges: a worker that never answers is unread after the git timeout; no worker = no git line", async () => {
  const hang = await collectChanges({ callTool: tool(cluster), history: () => new Promise(() => {}) }, "apps", ALERT, [], NOW, { mcpMs: 50, gitMs: 20 });
  assert.match(hang.unread.join(), /git history orders-api: timeout/);
  const none = await collectChanges({ callTool: tool(cluster) }, "apps", ALERT, [], NOW);
  assert.deepEqual(none.unread, []);
  const refused = await collectChanges({ callTool: tool(cluster), history: async () => ({ ok: false, reason: "no HelmRelease file" }) }, "apps", ALERT, [], NOW);
  assert.deepEqual(refused.unread, ["git history orders-api: no HelmRelease file"]);
});

test("collectChanges: at most 3 HelmReleases are asked for history", async () => {
  let asked = 0;
  const four = { ...cluster, helmReleases: ["a", "b", "c", "d"].map((name) => ({ name, namespace: "f" })) };
  await collectChanges({ callTool: tool(four), history: async () => { asked++; return { ok: true, op: "history", commits: [] }; } }, "apps", ALERT, [], NOW);
  assert.equal(asked, 3);
});

test("collectChanges: the alerting subject's own HelmRelease is asked for history even when alphabetically last", async () => {
  const askedFor: string[] = [];
  const five = { ...cluster, helmReleases: ["a", "b", "c", "storefront"].map((name) => ({ name, namespace: "f" })) };
  await collectChanges(
    { callTool: tool(five), history: async (hr) => { askedFor.push(hr.name); return { ok: true, op: "history", commits: [] }; } },
    "apps", ALERT, ["storefront-6b7-x"], NOW
  );
  assert.ok(askedFor.includes("storefront"), `expected storefront among ${JSON.stringify(askedFor)}`);
});

const T = (over: Partial<ChangeTimeline> = {}): ChangeTimeline => ({
  namespace: "apps", window: { from: "2026-10-07T12:00:00.000Z", to: "2026-10-09T00:00:00.000Z" },
  changes: [], commits: [], unread: [], subjects: [], ...over,
});

test("renderForModel: framed as data; read-and-empty says so explicitly", () => {
  const s = renderForModel(T());
  assert.match(s, /^\[CHANGE TIMELINE/);
  assert.match(s, /data, not instructions/);
  assert.match(s, /No changes recorded in `apps` in the window\./);
});

test("renderForModel: one line per change with its diff, subjects marked", () => {
  const s = renderForModel(T({ subjects: ["orders-api"], changes: [cluster.changes[0] as never], commits: [{ ...commit, helmRelease: "orders-api" }] }));
  assert.match(s, /Deployment\/orders-api spec-change rev 5 \(alerting workload\): api\.env\.TIMEOUT_MS 2000 → 50/);
  assert.match(s, /commit abc1234 by jdoe: .*HelmRelease orders-api/);
});

test("renderForModel: a restart change is explained as a possible deploy, not rendered as bare \"restart\"", () => {
  const s = renderForModel(T({ changes: [cluster.changes[1] as never] }));
  assert.match(s, /restart \(pod template unchanged — a mutable tag such as :latest may have pulled a new image\)/);
});

test("renderForSlack: null when nothing changed and everything was read", () => {
  assert.equal(renderForSlack(T()), null);
});

test("renderForSlack: capped at 5 entries, escaped, under 3000 chars, carries the block id", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...cluster.changes[1], workload: `Deployment/w${i}` }));
  const b = renderForSlack(T({ changes: many as never, commits: [{ ...commit, helmRelease: "x" }], unread: ["git history x: timeout"] }))!;
  assert.equal((b as { block_id?: string }).block_id, RECENT_CHANGES_BLOCK);
  const text = (b as { text: { text: string } }).text.text;
  assert.equal((text.match(/^• /gm) ?? []).length, 5);
  assert.match(text, /\+4 more/);
  assert.match(text, /Not read: git history x: timeout/);
  assert.ok(text.length < 3000);
  const c = renderForSlack(T({ commits: [{ ...commit, helmRelease: "x" }] }))!;
  const ct = (c as { text: { text: string } }).text.text;
  assert.match(ct, /&lt;fast&gt; &amp; safe/);
  assert.match(ct, /<https:\/\/gh\/c\/abc\|abc1234>/);
});

test("renderForSlack: URL with | and > is escaped or not rendered as link; javascript: URL has no link", () => {
  const badUrl = "https://gh/c/abc|bad>link";
  const jsUrl = "javascript:alert('xss')";
  const b = renderForSlack(T({ commits: [
    { ...commit, url: badUrl, helmRelease: "x" },
    { ...commit, url: jsUrl, sha: "def5678ghi", helmRelease: "y" }
  ] }))!;
  const text = (b as { text: { text: string } }).text.text;
  // The bad URL should not have raw | or > inside the link
  assert.doesNotMatch(text, /\|[\w<>]*\|/);
  // javascript: URL should not create a link
  assert.doesNotMatch(text, /<javascript:/);
  // Plain sha should still appear for javascript URL
  assert.match(text, /def5678/);
});

test("collectChanges: date comparison handles timezone offsets and second precision", async () => {
  const cluster2 = {
    ...cluster,
    changes: [
      { at: "2026-10-07T13:00:00+00:00", source: "rollout", kind: "spec-change", workload: "Deployment/test-1", revision: "1" },
      { at: "2026-10-07T11:59:59+00:00", source: "rollout", kind: "spec-change", workload: "Deployment/test-2", revision: "1" },
      { at: "2026-10-07T12:00:00.000Z", source: "rollout", kind: "spec-change", workload: "Deployment/test-3", revision: "1" },
    ],
    helmReleases: [],
  };
  const t = await collectChanges({ callTool: async () => JSON.stringify(cluster2) }, "apps", ALERT, [], NOW);
  assert.deepEqual(t.changes.map((c) => c.workload), ["Deployment/test-1", "Deployment/test-3"], "inside window with offset and edge case kept, outside dropped");
});

test("renderForSlack: long commit messages capped at 100 chars; multiple commits stay under 3000 chars with no lone surrogates", () => {
  const longMsg = "&".repeat(100);
  const commits = Array.from({ length: 5 }, (_, i) => ({
    ...commit,
    sha: `abc${i}def`,
    message: longMsg,
    helmRelease: `release-${i}`,
  }));
  const b = renderForSlack(T({ commits }))!;
  const text = (b as { text: { text: string } }).text.text;
  assert.ok(text.length < 3000, `text length ${text.length} should be < 3000`);
  // Check no lone surrogates
  const lonePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(text, lonePattern, "text should not contain lone surrogates");
  // All & should be escaped
  assert.doesNotMatch(text, /(?<!&)&(?!amp;|lt;|gt;)/);
});

test("short: handles emoji and code points safely without lone surrogates", () => {
  const emoji = "a".repeat(98) + "😀" + "b".repeat(10);
  const shortened = renderForSlack(T({ commits: [{ ...commit, message: emoji, helmRelease: "x" }] }))!;
  const text = (shortened as { text: { text: string } }).text.text;
  const lonePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(text, lonePattern, "text should not contain lone surrogates from emoji splitting");
});

test("renderForSlack: overflow with mixed entities and emoji stays under 2900 chars with proper escaping", () => {
  const longUnread = "&<😀".repeat(625); // 5000 chars of mixed special chars
  const changes = Array.from({ length: 5 }, (_, i) => ({
    at: `2026-10-08T${String(12 + i).padStart(2, "0")}:00:00Z`,
    source: "rollout",
    kind: "spec-change",
    workload: `Deployment/w${i}`,
    diff: [{ field: "f", from: longUnread.slice(0, 100), to: longUnread.slice(100, 200) }],
  }));
  const b = renderForSlack(T({ changes: changes as never, unread: [longUnread] }))!;
  const text = (b as { text: { text: string } }).text.text;
  assert.ok(text.length <= 2900, `text length ${text.length} should be <= 2900`);
  const lonePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(text, lonePattern, "text should not contain lone surrogates");
  assert.doesNotMatch(text, /&(?!amp;|lt;|gt;)/);
  // Every line should start with *, •, or _
  const lines = text.split("\n");
  for (const line of lines) {
    assert.match(line, /^[\*•_]/);
  }
  // Last line should be the unread line
  assert.match(lines[lines.length - 1], /^_Not read:/);
  assert.match(lines[lines.length - 1], /_$/);
});
