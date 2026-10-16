import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackApp } from "./index.js";

// The tour's tables are posted from the inventory the tool returned, before the model's prose.
// A Slack refusal of the blocks costs the tables, never the facts: the same message goes again as
// plain mrkdwn (the postRca pattern).
const INV = JSON.stringify({ scanned: { namespaces: 1, complete: true }, namespaces: [
  { name: "sample-apps", system: false, workloads: ["Deployment storefront — unmanaged"], hosts: [] }] });

const harness = (inventory: string | null, fail = false) => {
  const posted: any[] = [];
  const self: any = { agent: { lastToolResult: async () => inventory } };
  const client: any = { chat: { postMessage: async (m: any) => {
    if (fail && m.blocks) throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    posted.push(m);
  } } };
  const post = () => (SlackApp.prototype as any).postTourTables.call(self, "C1", "1.1", client);
  return { posted, post };
};

test("a tour's inventory goes out as table blocks with the same facts as text", async () => {
  const h = harness(INV);
  assert.equal(await h.post(), INV, "returns the inventory the tables were built from — the reply is stripped against it");
  assert.equal(h.posted.length, 1);
  assert.ok(h.posted[0].blocks.some((b: any) => b.type === "table"));
  assert.match(h.posted[0].text, /storefront/);
  assert.equal(h.posted[0].thread_ts, "1.1");
});

test("refused blocks are re-posted as plain text; no inventory posts nothing", async () => {
  const h = harness(INV, true);
  await h.post();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].blocks, undefined);
  assert.match(h.posted[0].text, /storefront/);
  const none = harness(null);
  assert.equal(await none.post(), null);
  assert.equal(none.posted.length, 0);
});

const FLOW_MODEL: any = {
  snapshot: { at: "2026-10-16T10:00:00.000Z", appliedRevision: "main@sha1:aca660bb", repoRevision: "aca660bb" },
  nodes: [
    { id: "wl/sample-apps/checkout-gateway", kind: "workload", namespace: "sample-apps", name: "checkout-gateway", workloadKind: "Deployment" },
    { id: "wl/sample-apps/orders-api", kind: "workload", namespace: "sample-apps", name: "orders-api", workloadKind: "Deployment" },
    { id: "svc/postgresql/postgresql", kind: "service", namespace: "postgresql", name: "postgresql" },
    { id: "svc/monitoring/jaeger", kind: "service", namespace: "monitoring", name: "jaeger" },
  ],
  edges: [
    { from: "wl/sample-apps/checkout-gateway", to: "wl/sample-apps/orders-api", kind: "calls", certainty: "observed", evidence: [{ type: "metric", query: "q" }] },
    { from: "wl/sample-apps/orders-api", to: "svc/postgresql/postgresql", kind: "depends", certainty: "configured", role: "app", evidence: [{ type: "env", workload: "orders-api", via: "DB_HOST" }] },
    { from: "wl/sample-apps/orders-api", to: "svc/monitoring/jaeger", kind: "depends", certainty: "configured", role: "telemetry", evidence: [{ type: "env", workload: "orders-api", via: "OTEL_EXPORTER_OTLP_ENDPOINT" }] },
  ],
  external: [],
  changeAt: { "wl/sample-apps/orders-api": { replicas: { path: "apps/dev/applications/orders-api/release.yaml", line: 7, key: "spec.values.replicaCount", gitValue: "2", drift: false } } },
  unknowns: [],
};

test("postFlowTables: two messages (flow, where to change); a refused table re-posts as the same facts in text", async () => {
  const posted: any[] = [];
  let refuse = true;
  const client: any = { chat: { postMessage: async (m: any) => {
    if (refuse && m.blocks) { refuse = false; throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } }); }
    posted.push(m);
  } } };
  await (SlackApp.prototype as any).postFlowTables.call({}, "C1", "1.1", client, FLOW_MODEL, "sample-apps");
  assert.equal(posted.length, 2);
  assert.equal(posted[0].blocks, undefined, "the refused one went again as text");
  assert.match(posted[0].text, /\*Request flow\*/);
  assert.ok(posted[1].blocks.some((b: any) => b.type === "table"));
  assert.match(posted[1].text, /\*Where to change it\*/);
});

test("tourContext: a namespace tour prefetches the model as framed data; anything missing is today's tour", async () => {
  const self = (ns: string | null, model: any) => ({ agent: { tourNamespace: async () => ns, clusterModel: async () => model } });
  const ctx = (s: any, text: string) => (SlackApp.prototype as any).tourContext.call(s, text);
  const ok = await ctx(self("sample-apps", FLOW_MODEL), "jelasin namespace sample-apps");
  assert.equal(ok.ns, "sample-apps");
  assert.match(ok.text, /^\[CLUSTER MODEL/);
  assert.equal((await ctx(self(null, FLOW_MODEL), "jelasin cluster ini")).text, "");
  assert.equal((await ctx(self("sample-apps", null), "jelasin namespace sample-apps")).text, "");
  let asked = false;
  const notTour = { agent: { tourNamespace: async () => { asked = true; return "x"; }, clusterModel: async () => FLOW_MODEL } };
  assert.equal((await ctx(notTour, "why is the pod crashing?")).text, "");
  assert.equal(asked, false, "a non-tour mention never pays for the model");
});

test("tourContext is bounded: a model build that hangs (a down worker) never holds the tour", async () => {
  const s = { agent: { tourNamespace: async () => "sample-apps", clusterModel: () => new Promise(() => {}) } };
  const t0 = Date.now();
  const r = await (SlackApp.prototype as any).tourContext.call(s, "jelasin namespace sample-apps", 50);
  assert.equal(r.text, "");
  assert.equal(r.model, null);
  assert.ok(Date.now() - t0 < 1000, "returned at the bound, not when the build gave up");
});
