import { test } from "node:test";
import assert from "node:assert/strict";
import { capForUnboundCluster, parseConfidence } from "./index.js";

// Multi-cluster 2a: an alert with no usable `cluster` label is investigated with no Kubernetes at
// all, so whatever it concludes cannot be more than Low — and Low pages on-call.
const rca = (level: string) => `*📍 Root Cause*\nSomething.\n\n*📈 Confidence:* \`${level}\` — evidence from metrics.`;

test("an unlabelled alert is capped to Low", () => {
  for (const level of ["High", "Medium"]) {
    const { text, capped } = capForUnboundCluster(rca(level));
    assert.equal(capped, true);
    assert.equal(parseConfidence(text), "low");
    assert.match(text, /no cluster label — Kubernetes was not read/);
  }
});

test("Low, or no confidence line, is left alone", () => {
  assert.deepEqual(capForUnboundCluster(rca("Low")), { text: rca("Low"), capped: false });
  assert.deepEqual(capForUnboundCluster("no rating here"), { text: "no rating here", capped: false });
});
