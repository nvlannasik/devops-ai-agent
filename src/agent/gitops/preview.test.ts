import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitOpsPreview } from "./preview.js";

const preview = {
  gitOpsPrEligible: true,
  source: "flux-helmrelease",
  helmRelease: { name: "ingress-nginx", namespace: "nginx-ingress" },
  workload: "deployment/nginx-ingress/ctrl",
  action: "set_image",
  container: "controller",
  changes: [{ field: "image", from: "repo:1", to: "repo:2" }],
  message: "managed by Flux HelmRelease",
};

test("parseGitOpsPreview accepts a well-formed PR preview", () => {
  const r = parseGitOpsPreview(JSON.stringify(preview));
  assert.ok(r && r.gitOpsPrEligible && r.helmRelease.name === "ingress-nginx" && r.action === "set_image");
});

test("parseGitOpsPreview returns null for a normal dry-run validation result", () => {
  const normal = { action: "set_image", workload: "deployment/ns/app", dryRun: true, result: "validated (nothing was changed)" };
  assert.equal(parseGitOpsPreview(JSON.stringify(normal)), null);
});

test("parseGitOpsPreview rejects malformed / incomplete previews", () => {
  assert.equal(parseGitOpsPreview("not json"), null);
  assert.equal(parseGitOpsPreview(JSON.stringify({ ...preview, gitOpsPrEligible: false })), null);
  assert.equal(parseGitOpsPreview(JSON.stringify({ ...preview, helmRelease: { name: "x" } })), null); // no namespace
  assert.equal(parseGitOpsPreview(JSON.stringify({ ...preview, changes: "nope" })), null);
});
