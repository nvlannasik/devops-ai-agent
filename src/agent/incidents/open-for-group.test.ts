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
