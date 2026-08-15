import { test } from "node:test";
import assert from "node:assert/strict";
import { leaksRcaStructure } from "./blocks.js";

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
