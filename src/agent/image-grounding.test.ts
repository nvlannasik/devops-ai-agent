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

// Verbatim from bench A03 attempt 2, 2026-09-25. The fixture runs nginx:alpine and breaks the tag;
// the model read `nginx:alpine` out of a tool result and proposed it back in Docker Hub's canonical
// long form. Dropping only `docker.io/` left `library/nginx:alpine` to be matched against a bare
// `nginx:alpine`, so the correct answer was refused as invented and the case failed the proposal
// axis. Every spelling below denotes the same image and must ground against any of the others.
test("Docker Hub's spellings of an official image are one image", () => {
  const short = '{"containers":[{"name":"web","image":"nginx:alpine"}]}';
  for (const spelling of ["nginx:alpine", "library/nginx:alpine", "docker.io/library/nginx:alpine", "index.docker.io/library/nginx:alpine"]) {
    assert.equal(unseenImageRefusal(setImage(spelling), short, ""), null, `${spelling} against a bare listing`);
  }
  const long = '{"containers":[{"name":"web","image":"docker.io/library/nginx:alpine"}]}';
  assert.equal(unseenImageRefusal(setImage("nginx:alpine"), long, ""), null, "bare proposal against a fully-qualified listing");

  // The normalisation must not become a wildcard: a different TAG is still ungrounded.
  assert.notEqual(unseenImageRefusal(setImage("docker.io/library/nginx:1.27"), short, ""), null);

  // Recorded, not endorsed, and PRE-EXISTING — this passed identically before the normalisation
  // above. The comparison is substring containment, so a bare `nginx:alpine` also grounds against
  // `myregistry.com/library/nginx:alpine`, which is a different registry and therefore a different
  // image. Asserted as-is so the looseness is written down rather than assumed absent. Tightening
  // it means telling a Docker Hub prefix apart from a genuine path segment on every listing format
  // in the cluster, and getting that wrong reintroduces exactly the false refusal this test exists
  // to prevent — so it stays until something is measured to need it.
  assert.equal(unseenImageRefusal(setImage("nginx:alpine"), '{"image":"myregistry.com/library/nginx:alpine"}', ""), null);
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
