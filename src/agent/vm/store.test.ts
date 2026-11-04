import { test } from "node:test";
import assert from "node:assert/strict";
import { VmStore } from "./store.js";
import { parseVmTokens } from "../../config/index.js";

// A fake pg pool: records every query, answers from a queue.
const fakePool = (answers: Array<{ rows: unknown[] }> = []) => {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  return { seen, query: async (text: string, values: unknown[] = []) => (seen.push({ text, values }), answers.shift() ?? { rows: [] }) };
};

test("claim expires stale actions, then takes one pending action of THIS host atomically", async () => {
  const pool = fakePool([{ rows: [] }, { rows: [{ id: 7, unit: "nginx.service", action: "restart" }] }]);
  const got = await new VmStore(pool as never).claim("vm-a");
  assert.deepEqual(got, { id: 7, unit: "nginx.service", action: "restart" });
  assert.match(pool.seen[0]!.text, /status = 'expired'[\s\S]*host = \$1[\s\S]*15 minutes/);
  assert.match(pool.seen[1]!.text, /UPDATE vm_actions[\s\S]*status = 'claimed'[\s\S]*host = \$1[\s\S]*status = 'pending'[\s\S]*15 minutes[\s\S]*RETURNING/);
  assert.deepEqual(pool.seen[1]!.values, ["vm-a"]);
});

test("finish is scoped to the caller's host and a claimed action", async () => {
  const pool = fakePool([{ rows: [{ remediation_id: 12 }] }]);
  assert.deepEqual(await new VmStore(pool as never).finish(7, "vm-a", "succeeded", { exitCode: 0 }), { remediationId: 12 });
  assert.match(pool.seen[0]!.text, /WHERE id = \$1 AND host = \$2 AND status = 'claimed'/);
});

test("registered means a heartbeat within 5 minutes; no pool means nothing", async () => {
  const pool = fakePool([{ rows: [{ units: ["nginx.service"] }] }]);
  assert.deepEqual(await new VmStore(pool as never).registered("vm-a"), { units: ["nginx.service"] });
  assert.match(pool.seen[0]!.text, /5 minutes/);
  assert.equal(await new VmStore(null).registered("vm-a"), null);
  assert.equal(await new VmStore(null).claim("vm-a"), null);
});

test("parseVmTokens: name=token pairs; unset is none; malformed fails boot", () => {
  assert.equal(parseVmTokens(undefined).size, 0);
  assert.deepEqual([...parseVmTokens("vm-web-01=abc123,vm-db-01=def456")], [["vm-web-01", "abc123"], ["vm-db-01", "def456"]]);
  assert.throws(() => parseVmTokens("vm-web-01"), /name=token/);
  assert.throws(() => parseVmTokens("VM=x"), /bad VM name/);
  assert.throws(() => parseVmTokens("a=x,a=y"), /duplicate/);
});
