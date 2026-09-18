import { test } from "node:test";
import assert from "node:assert/strict";
import { imageGapRepo, IMAGE_GAP_NOTICE } from "./index.js";

// The shape A03 produces: describe output carrying the failing reference and the pull failure.
const evidence = `{"name":"storefront-74598cf94d-l6f42","image":"nginx:no-such-tag-9f2c","state":"Waiting: ImagePullBackOff"}`;

test("an answer naming only the failing tag is a gap", () => {
  assert.equal(imageGapRepo("The pod cannot pull `nginx:no-such-tag-9f2c`.", evidence), "nginx");
});

test("an answer naming a working tag beside it is not", () => {
  const rca = "`nginx:no-such-tag-9f2c` does not exist; the previous ReplicaSet runs `nginx:alpine`.";
  assert.equal(imageGapRepo(rca, evidence), null);
});

// The gate is driven by the evidence, never by what looks like an image in prose.
test("no pull failure in the evidence, no gate", () => {
  const quiet = `{"name":"api-1-a","image":"nginx:1.27","state":"Running"}`;
  assert.equal(imageGapRepo("The pod runs `nginx:1.27`.", quiet), null);
});

test("an answer that names no image at all is still a gap", () => {
  assert.equal(imageGapRepo("The container cannot start.", evidence), "nginx");
});

// registry:5000/app:v2 — the repo has a colon in it, and splitting on the first one loses the host.
test("a registry port is not mistaken for a tag", () => {
  const ev = `{"image":"registry:5000/app:v2-broken","state":"ErrImagePull"}`;
  assert.equal(imageGapRepo("cannot pull `registry:5000/app:v2-broken`", ev), "registry:5000/app");
  assert.equal(imageGapRepo("roll back to `registry:5000/app:v1`", ev), null);
});

test("the notice says where the working tag lives and what to say if it is gone", () => {
  assert.match(IMAGE_GAP_NOTICE, /k8s_list_replicasets/);
  assert.match(IMAGE_GAP_NOTICE, /does not delete the ReplicaSet it replaced/);
  assert.match(IMAGE_GAP_NOTICE, /if you look and the previous ReplicaSet is gone, say so/i);
});
