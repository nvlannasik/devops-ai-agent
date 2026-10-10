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

test("a rollback card renders its dry-run summary as a fenced block, not a 400-char code span", () => {
  const undo: Proposal = { ...proposal, action: "k8s_rollout_undo", summary: "roll back deployment `apps/api` to revision 1" };
  const summary = "revision 2 → 1\n" + "x".repeat(2000);
  const t = (buildRemediationCard(3, undo, summary) as Array<{ text?: { text: string } }>)[0].text!.text;
  assert.ok(t.includes("*Dry-run:* ✅\n```\nrevision 2 → 1\n"));
  assert.ok(t.includes("x".repeat(1500 - "revision 2 → 1\n".length) + "\n```"), "kept up to 1500 chars");
  assert.ok(!t.includes("x".repeat(1500)), "and no more");
  const set = (buildRemediationCard(3, proposal, "validated") as Array<{ text?: { text: string } }>)[0].text!.text;
  assert.match(set, /\*Dry-run:\* ✅ `validated`/, "other actions keep the inline span");
});
