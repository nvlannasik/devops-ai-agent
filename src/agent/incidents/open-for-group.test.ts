import { test } from "node:test";
import assert from "node:assert/strict";
import { IncidentMemory } from "./index.js";

test("openForGroup: exact group, still open, top-level, and opened within the cap", async () => {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => (
      seen.push({ text, values }),
      { rows: [{ id: "107", channel: "C1", thread_ts: "107.1", created_at: "2026-11-20T21:41:41.878Z" }] }
    ),
  };
  const got = await new IncidentMemory(pool as never).openForGroup({ alertname: "FluxControllerDown", pod: "p" });
  assert.deepEqual(got, { id: 107, channel: "C1", threadTs: "107.1", createdAt: new Date("2026-11-20T21:41:41.878Z") });
  assert.match(seen[0]!.text, /group_labels = \$1::jsonb AND resolved_at IS NULL AND parent_id IS NULL[\s\S]*created_at > now\(\) - make_interval\(hours => \$2\)/);
  assert.deepEqual(seen[0]!.values, ['{"alertname":"FluxControllerDown","pod":"p"}', 72]);
  assert.equal(await new IncidentMemory(null).openForGroup({ alertname: "x" }), null);
});

test("resolvedRecently: same alertname, top-level, resolved in the window with a root cause; markRepeat sets repeat_of", async () => {
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => (
      seen.push({ text, values }),
      { rows: [{ id: "77", created_at: "2026-11-14T15:00:00Z", resolved_at: "2026-11-14T16:00:00Z", root_cause: "etcd", group_labels: { node: "master3-vm" }, subjects: null }] }
    ),
  };
  const mem = new IncidentMemory(pool as never);
  const rows = await mem.resolvedRecently("KubernetesNodeMemoryPressure", 24, { cluster: "dev", local: "dev" });
  assert.deepEqual(rows, [{ id: 77, createdAt: new Date("2026-11-14T15:00:00Z"), resolvedAt: new Date("2026-11-14T16:00:00Z"), rootCause: "etcd", groupLabels: { node: "master3-vm" }, subjects: [] }]);
  assert.match(seen[0]!.text, /alertname = \$1 AND parent_id IS NULL[\s\S]*resolved_at IS NOT NULL AND root_cause IS NOT NULL[\s\S]*resolved_at > now\(\) - make_interval\(hours => \$2\)[\s\S]*IS NOT DISTINCT FROM \$4::text/);
  assert.deepEqual(seen[0]!.values, ["KubernetesNodeMemoryPressure", 24, "dev", "dev"]);
  await mem.markRepeat(120, 77);
  assert.match(seen[1]!.text, /UPDATE incidents SET repeat_of = \$2 WHERE id = \$1/);
  assert.deepEqual(seen[1]!.values, [120, 77]);
});
