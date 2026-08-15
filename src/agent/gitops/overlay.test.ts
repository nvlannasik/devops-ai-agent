import { test } from "node:test";
import assert from "node:assert/strict";
import { kustomizeRefOf, fluxPathToPrefix } from "./overlay.js";

test("kustomizeRefOf reads the Flux Kustomization ref from HR labels, else null", () => {
  const hr = { metadata: { labels: { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-app" } } };
  assert.deepEqual(kustomizeRefOf(hr), { name: "apps", namespace: "flux-app" });
  assert.equal(kustomizeRefOf({ metadata: { labels: { "kustomize.toolkit.fluxcd.io/name": "apps" } } }), null); // no namespace
  assert.equal(kustomizeRefOf({ metadata: {} }), null);
  assert.equal(kustomizeRefOf({}), null);
});

test("fluxPathToPrefix normalizes spec.path to a repo-relative prefix", () => {
  assert.equal(fluxPathToPrefix({ spec: { path: "./apps/dev/applications" } }), "apps/dev/applications");
  assert.equal(fluxPathToPrefix({ spec: { path: "apps/prd/systems/" } }), "apps/prd/systems");
  assert.equal(fluxPathToPrefix({ spec: { path: "/apps/stg/applications" } }), "apps/stg/applications");
  assert.equal(fluxPathToPrefix({ spec: { path: "" } }), undefined);
  assert.equal(fluxPathToPrefix({ spec: {} }), undefined);
  assert.equal(fluxPathToPrefix({}), undefined);
});
