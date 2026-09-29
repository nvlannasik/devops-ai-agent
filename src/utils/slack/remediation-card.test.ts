import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRemediationCard } from "./remediation-card.js";
import type { Proposal } from "../../agent/remediation/proposal.js";

const proposal: Proposal = {
  action: "k8s_set_image",
  namespace: "nginx-ingress",
  name: "ctrl",
  reason: "wrong tag",
  toolParams: {},
  summary: "set image → repo:2",
};

const text = (blocks: ReturnType<typeof buildRemediationCard>) =>
  JSON.stringify(blocks);

test("direct remediation card shows the compact dry-run inline (no diff block)", () => {
  const blocks = buildRemediationCard(1, proposal, "validated (nothing was changed)", ["U1"]);
  const t = text(blocks);
  // A card is only ever posted for a change that passed every gate and the dry-run, so it says
  // what it is: remediation is needed, and here is the one to approve (2026-09-29).
  assert.match(t, /\*Remediation needed\* — set image/);
  assert.doesNotMatch(t, /Proposed remediation/);
  assert.doesNotMatch(t, /```diff/);
  assert.match(t, /<@U1>/); // approver mentioned
});

test("GitOps PR card renders a diff block + the target file/key", () => {
  const diff = "--- a/apps/base/release.yaml\n+++ b/apps/base/release.yaml\n-      tag: v1\n+      tag: v2";
  const blocks = buildRemediationCard(2, proposal, diff, ["U1"], {
    path: "apps/base/release.yaml",
    valuesKey: "tag",
    helmRelease: { name: "ingress-nginx", namespace: "nginx-ingress" },
  });
  const t = text(blocks);
  assert.match(t, /\*Remediation needed \(GitOps PR\)\*/);
  assert.match(t, /diff/); // fenced diff block
  assert.match(t, /apps\/base\/release.yaml/);
  assert.match(t, /Approve opens a PR/);
});
