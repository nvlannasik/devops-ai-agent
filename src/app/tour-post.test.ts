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
