import { test } from "node:test";
import assert from "node:assert/strict";
import { unseenImageRefusal } from "./index.js";
import { parseProposal, type Proposal } from "./remediation/proposal.js";

const setImage = (image: string): Proposal =>
  parseProposal(JSON.stringify({ action: "k8s_set_image", namespace: "sample-apps", workload: "checkout-gateway", kind: "deployment", image }))!;

// What k8s_list_pods / deployment listings actually return for this workload.
const observed = '{"name":"checkout-gateway","containers":[{"name":"checkout-gateway","image":"docker.io/nvlannasik/checkout-gateway:latest"}]}';

// Verbatim from remediation 80, 2026-09-22: an image no tool had ever returned.
test("an invented image is refused", () => {
  const r = unseenImageRefusal(setImage("registry.example.com/checkout-gateway:v1.2"), observed, "");
  assert.match(r ?? "", /refused: no tool result in this thread shows that image/);
});

test("an image a tool result showed passes, with or without docker.io/", () => {
  const history = observed + '\nrevision 3: nvlannasik/checkout-gateway:1.4.0';
  assert.equal(unseenImageRefusal(setImage("nvlannasik/checkout-gateway:1.4.0"), history, ""), null);
  assert.equal(unseenImageRefusal(setImage("docker.io/nvlannasik/checkout-gateway:1.4.0"), history, ""), null);
});

test("a tag the user named, on a repo the cluster runs, passes", () => {
  assert.equal(unseenImageRefusal(setImage("nvlannasik/checkout-gateway:v1.3"), observed, "change the image tag to v1.3"), null);
  // ...but not a tag the user never said, and not a registry nobody runs
  assert.notEqual(unseenImageRefusal(setImage("nvlannasik/checkout-gateway:v1.4"), observed, "change the image tag to v1.3"), null);
  assert.notEqual(unseenImageRefusal(setImage("registry.example.com/checkout-gateway:v1.3"), observed, "change the image tag to v1.3"), null);
});

test("with no thread at all, only the user's own words can ground it", () => {
  assert.notEqual(unseenImageRefusal(setImage("nvlannasik/checkout-gateway:v2"), null, ""), null);
  assert.equal(unseenImageRefusal(setImage("nvlannasik/checkout-gateway:v2"), null, "set image to nvlannasik/checkout-gateway:v2"), null);
});

test("other actions are not this gate's business", () => {
  const restart = parseProposal('{"action":"k8s_rollout_restart","namespace":"a","workload":"b"}')!;
  assert.equal(unseenImageRefusal(restart, null, ""), null);
});
