import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClusterModel, ClusterModelCache, type ModelSources } from "./index.js";

const INV = JSON.stringify({
  scanned: { namespaces: 1, complete: true, configMaps: true }, fluxRevisions: [],
  namespaces: [{ name: "sample-apps", system: false, services: [], ingresses: [], workloads: [
    { kind: "Deployment", name: "orders-api", ready: 1, desired: 2, images: ["x:1"], managedBy: { type: "helmrelease", name: "orders-api", namespace: "flux-app" }, dependsOn: [], externalHosts: [], unresolved: [] },
    { kind: "Deployment", name: "storefront", ready: 1, desired: 1, images: ["y:1"], managedBy: { type: "helmrelease", name: "storefront", namespace: "flux-app" }, dependsOn: [], externalHosts: [], unresolved: [] },
  ] }],
});

function sources(over: Partial<ModelSources> = {}): ModelSources & { locateCalls: any[] } {
  const locateCalls: any[] = [];
  return {
    locateCalls,
    inventory: async () => INV,
    callGraph: async () => ({}),
    locate: async (p, targets) => { locateCalls.push({ p, targets }); return { ok: true, op: "locate", revision: "abc", releases: [] } as any; },
    overlayPath: async () => "apps/dev/applications",
    now: () => 1_000,
    ...over,
  };
}

test("one locate per distinct overlay prefix, with the running image and desired replicas", async () => {
  const s = sources();
  const m = await buildClusterModel(s, "sample-apps");
  assert.ok(m);
  assert.equal(s.locateCalls.length, 1);
  assert.equal(s.locateCalls[0].p, "apps/dev/applications");
  assert.deepEqual(s.locateCalls[0].targets, [
    { name: "orders-api", namespace: "flux-app", current: { image: "x:1", replicas: 2 } },
    { name: "storefront", namespace: "flux-app", current: { image: "y:1", replicas: 1 } },
  ]);
});

test("every source fails open: a throwing call graph and locate become unknowns; an unreadable inventory is null", async () => {
  const m = await buildClusterModel(sources({ callGraph: async () => { throw new Error("prom down"); }, locate: async () => { throw new Error("GitOps SQS timeout"); } }), "sample-apps");
  assert.match(m!.unknowns.join("\n"), /call graph unavailable/);
  assert.match(m!.unknowns.join("\n"), /GitOps SQS timeout/);
  assert.equal(await buildClusterModel(sources({ inventory: async () => "Error: forbidden" }), "sample-apps"), null);
  const noGitops = await buildClusterModel(sources({ locate: undefined }), "sample-apps");
  assert.match(noGitops!.unknowns.join("\n"), /GitOps is not configured/);
});

test("cache: warm within 5 min; stale is served while rebuilding; peek never waits and kicks a build", async () => {
  let t = 0;
  let builds = 0;
  const cache = new ClusterModelCache(async () => { builds++; return { snapshot: { at: String(builds) } } as any; }, 300_000, () => t);
  assert.equal(cache.peek("a"), null);
  await new Promise((r) => setImmediate(r));
  assert.equal(builds, 1, "peek on a cold key starts one build");
  assert.equal((await cache.get("a"))!.snapshot.at, "1");
  t = 299_999;
  await cache.get("a");
  assert.equal(builds, 1);
  t = 300_001;
  assert.equal((await cache.get("a"))!.snapshot.at, "1", "stale is served while the rebuild runs");
  await new Promise((r) => setImmediate(r));
  assert.equal(builds, 2);
  assert.equal(cache.peek("a")!.snapshot.at, "2");
});
