import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, fmtDate, fmtPct, fmtInt } from "./html.js";

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

test("fmtDate is readable and handles the missing case", () => {
  assert.equal(fmtDate(new Date("2026-07-28T23:48:28.872Z")), "2026-07-28 23:48");
  assert.equal(fmtDate("2026-07-28T23:48:28.872Z"), "2026-07-28 23:48");
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
