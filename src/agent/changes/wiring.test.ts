import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DevOpsAgent } from "../index.js";

const cluster = JSON.stringify({ changes: [], helmReleases: [{ name: "api", namespace: "flux-app" }], unread: [] });

test("the agent method asks the worker for history with the overlay it resolved; no namespace means no timeline", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const fake = {
    mcp: { callTool: async () => cluster },
    gitops: { request: async (b: Record<string, unknown>) => { sent.push(b); return { ok: true, op: "history", commits: [] }; } },
    resolveOverlayPath: async () => "apps/dev/applications",
  };
  const t = await DevOpsAgent.prototype.collectChanges.call(fake as never, "apps", new Date(), []);
  assert.deepEqual(t?.unread, []);
  assert.equal(sent[0].op, "history");
  assert.equal(sent[0].pathPrefix, "apps/dev/applications");
  assert.deepEqual(sent[0].helmRelease, { name: "api", namespace: "flux-app" });
  assert.equal(await DevOpsAgent.prototype.collectChanges.call(fake as never, undefined, new Date(), []), null);
});

test("without a GitOps bridge there is no git source at all", async () => {
  const t = await DevOpsAgent.prototype.collectChanges.call({ mcp: { callTool: async () => cluster }, gitops: null } as never, "apps", new Date(), []);
  assert.deepEqual(t?.unread, []);
});

test("migration 012 adds incidents.changes", () => {
  assert.match(readFileSync(new URL("../../../migrations/012_incident_changes.sql", import.meta.url), "utf8"), /ALTER TABLE incidents ADD COLUMN IF NOT EXISTS changes jsonb/);
});

test("timelineFor: this process's copy first, then the incident row's", async () => {
  const fake = {
    mcp: { callTool: async () => JSON.stringify({ changes: [], helmReleases: [], unread: [] }) },
    gitops: null,
    timelines: new Map(),
    incidents: { changesForThread: async (ts: string) => (ts === "stored" ? { namespace: "db", changes: [], commits: [], unread: [], subjects: [], window: { from: "", to: "" } } : null) },
  };
  await DevOpsAgent.prototype.collectChanges.call(fake as never, "apps", new Date(), [], "live");
  assert.equal((await DevOpsAgent.prototype.timelineFor.call(fake as never, "live"))?.namespace, "apps");
  assert.equal((await DevOpsAgent.prototype.timelineFor.call(fake as never, "stored"))?.namespace, "db");
  assert.equal(await DevOpsAgent.prototype.timelineFor.call(fake as never, "none"), null);
  assert.equal(await DevOpsAgent.prototype.timelineFor.call(fake as never, undefined), null);
});
