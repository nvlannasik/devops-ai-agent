import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImage, imageExists } from "./registry.js";

test("parseImage: Docker Hub defaults, library images, other registries, digests", () => {
  assert.deepEqual(parseImage("nginx"), { registry: "registry-1.docker.io", repository: "library/nginx", reference: "latest" });
  assert.deepEqual(parseImage("nvlannasik/orders-api:1.4.2"), { registry: "registry-1.docker.io", repository: "nvlannasik/orders-api", reference: "1.4.2" });
  assert.deepEqual(parseImage("docker.io/nvlannasik/x:2"), { registry: "registry-1.docker.io", repository: "nvlannasik/x", reference: "2" });
  assert.deepEqual(parseImage("ghcr.io/fluxcd/helm-controller:v1.6.1"), { registry: "ghcr.io", repository: "fluxcd/helm-controller", reference: "v1.6.1" });
  assert.deepEqual(parseImage("localhost:5000/app:dev"), { registry: "localhost:5000", repository: "app", reference: "dev" });
  assert.equal(parseImage("quay.io/prometheus/prometheus@sha256:abc")!.reference, "sha256:abc");
  assert.equal(parseImage(""), null);
  assert.equal(parseImage("two words"), null);
});

// What Docker Hub really did on 2026-11-24, from the agent pod: 401 with a Bearer challenge, an
// anonymous token, then 200 for nvlannasik/devops-ai-agent:latest and 404 for a tag never pushed.
const hub = (status: number) => {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("https://auth.docker.io/token")) return new Response(JSON.stringify({ token: "t0k" }), { status: 200 });
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (!auth) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:nvlannasik/devops-ai-agent:pull"' } });
    return new Response(null, { status });
  }) as typeof fetch;
  return { f, calls };
};

test("imageExists follows the token challenge once: 200 exists, 404 does not, anything else is not a verdict", async () => {
  const ok = hub(200);
  assert.deepEqual(await imageExists("nvlannasik/devops-ai-agent:latest", ok.f), { exists: true });
  assert.deepEqual(ok.calls, [
    "HEAD https://registry-1.docker.io/v2/nvlannasik/devops-ai-agent/manifests/latest",
    "GET https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Anvlannasik%2Fdevops-ai-agent%3Apull",
    "HEAD https://registry-1.docker.io/v2/nvlannasik/devops-ai-agent/manifests/latest",
  ]);
  assert.deepEqual(await imageExists("nvlannasik/devops-ai-agent:does-not-exist", hub(404).f), { exists: false });
  assert.deepEqual(await imageExists("nvlannasik/private:1", hub(401).f), { unknown: "the registry answered 401" });
  assert.deepEqual(await imageExists("x:1", (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as never), { unknown: "getaddrinfo ENOTFOUND" });
});
