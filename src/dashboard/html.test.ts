import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, fmtAgo, fmtDate, fmtDuration, fmtPct, fmtInt, timeTag } from "./html.js";

// THE security test. `rca` and `root_cause` are LLM output — arbitrary text that can
// contain markup — and alertname/namespace come from Alertmanager labels. Rendering
// either raw is cross-site scripting whose source is our own model.
test("esc neutralises every character that can break out of HTML", () => {
  assert.equal(esc(`<script>alert(1)</script>`), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(esc(`" onmouseover="x`), "&quot; onmouseover=&quot;x");
  assert.equal(esc(`' & '`), "&#39; &amp; &#39;");
  // ampersand must be escaped FIRST or the other entities get double-escaped
  assert.equal(esc(`&lt;`), "&amp;lt;");
});

test("esc renders null and undefined as empty, never the string 'null'", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

// The Z is load-bearing, not decoration: these timestamps sit beside kubectl and Loki output
// and an on-call reads them from a machine that is not on UTC. Dropping it makes every time on
// the dashboard silently ambiguous, so it is pinned here rather than left to taste.
test("fmtDate is readable, marks its zone, and handles the missing case", () => {
  assert.equal(fmtDate(new Date("2026-07-28T23:48:28.872Z")), "2026-07-28 23:48Z");
  assert.equal(fmtDate("2026-07-28T23:48:28.872Z"), "2026-07-28 23:48Z");
  assert.equal(fmtDate(null), "—");
  assert.equal(fmtDate("not-a-date"), "—");
});

test("fmtPct never divides by zero", () => {
  assert.equal(fmtPct(3, 4), "75%");
  assert.equal(fmtPct(0, 0), "—");
  assert.equal(fmtPct(1, 3), "33%");
});

test("fmtInt groups thousands", () => {
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(fmtInt(0), "0");
});

// Relative time is what an on-call reads first: "how long has this been firing" is the
// question, and an absolute UTC stamp answers it only after arithmetic. The absolute value
// never leaves the page — timeTag() keeps it in datetime= and title= — so nothing is lost.
test("fmtAgo says how long ago, in the largest unit that still carries information", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  assert.equal(fmtAgo(new Date("2026-08-24T11:59:30Z"), now), "just now");
  assert.equal(fmtAgo(new Date("2026-08-24T11:48:00Z"), now), "12m ago");
  assert.equal(fmtAgo(new Date("2026-08-24T07:00:00Z"), now), "5h ago");
  assert.equal(fmtAgo(new Date("2026-08-21T12:00:00Z"), now), "3d ago");
  // past 30 days a count of days stops being readable — the date itself is shorter
  assert.equal(fmtAgo(new Date("2026-05-01T09:14:00Z"), now), "2026-05-01");
});

// A dashboard clock that is a few seconds ahead of Postgres would otherwise render "-0m ago".
test("fmtAgo clamps a future timestamp rather than counting backwards", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  assert.equal(fmtAgo(new Date("2026-08-24T12:00:05Z"), now), "just now");
});

test("fmtAgo has the same missing case as fmtDate", () => {
  assert.equal(fmtAgo(null), "—");
  assert.equal(fmtAgo("not-a-date"), "—");
});

// The point of the element: the relative reading is what a human sees, the absolute one stays
// machine-readable in datetime= and one hover away in title=.
test("timeTag carries the absolute instant alongside the relative reading", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  const html = timeTag(new Date("2026-08-24T11:48:00Z"), now);
  assert.match(html, /datetime="2026-08-24T11:48:00\.000Z"/);
  assert.match(html, /title="2026-08-24 11:48Z"/);
  assert.match(html, />12m ago</);
});

test("timeTag renders a missing timestamp as a plain dash, not an empty <time>", () => {
  assert.equal(timeTag(null), "—");
});

// MTTR is a duration, and a duration in milliseconds is not a reading. Two units at most —
// "2h 14m", never "2h 14m 9s" — because the third is below the precision anything on this page
// is measured to and only makes the figure harder to compare against its neighbour.
test("fmtDuration reads as time, in at most two units", () => {
  assert.equal(fmtDuration(45_000), "45s");
  assert.equal(fmtDuration(14 * 60_000), "14m");
  assert.equal(fmtDuration(2 * 3_600_000 + 14 * 60_000), "2h 14m");
  assert.equal(fmtDuration(3 * 86_400_000 + 5 * 3_600_000), "3d 5h");
  // a whole number of hours drops the empty minutes rather than printing "2h 0m"
  assert.equal(fmtDuration(2 * 3_600_000), "2h");
});

// null is "nothing resolved in this window", which is not zero — see Previous in queries.ts.
test("fmtDuration keeps 'no data' and 'instant' apart", () => {
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(0), "0s");
});
