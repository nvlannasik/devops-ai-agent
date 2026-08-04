import { test } from "node:test";
import assert from "node:assert/strict";
import { barChart } from "./svg.js";

test("barChart renders one rect per point", () => {
  const svg = barChart([
    { label: "W1", value: 3 },
    { label: "W2", value: 7 },
    { label: "W3", value: 5 },
  ]);
  assert.equal((svg.match(/<rect/g) ?? []).length, 3);
  assert.match(svg, /<svg[^>]+viewBox=/);
});

// An empty series is the normal state of a fresh deployment, not an edge case.
test("barChart on an empty series renders a placeholder, not a broken SVG", () => {
  const svg = barChart([]);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.match(svg, /no data/i);
});

// A single point makes max === min; a naive scale divides by zero here.
test("barChart survives a single point and an all-zero series", () => {
  for (const points of [[{ label: "W1", value: 4 }], [{ label: "A", value: 0 }, { label: "B", value: 0 }]]) {
    const svg = barChart(points);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  }
});

test("barChart escapes its labels", () => {
  assert.match(barChart([{ label: `<b>`, value: 1 }]), /&lt;b&gt;/);
});

test("barChart escapes string values (e.g. from Postgres int8)", () => {
  // Postgres bigint/int8 columns are returned as strings at runtime, even though
  // TypeScript says number. This test verifies defense-in-depth escaping.
  const stringValue = "<script>alert(1)</script>" as unknown as number;
  const svg = barChart([{ label: "malicious", value: stringValue }]);
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
});
