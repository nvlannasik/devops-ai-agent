import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceRows, evidenceTable, toSpans } from "./rca-tables.js";

const EVIDENCE =
  "• *Fact:* container `api` was OOMKilled at its `128Mi` limit — _k8s_describe_pod_ `shop/api-7d9f-x2k`\n" +
  "• *Fact:* memory reached 99% of the limit before each kill — _prometheus_query_ `container_memory_working_set_bytes`";

test("a finding and its source split into two columns", () => {
  assert.deepEqual(evidenceRows(EVIDENCE), [
    ["*Fact:* container `api` was OOMKilled at its `128Mi` limit", "_k8s_describe_pod_ `shop/api-7d9f-x2k`"],
    ["*Fact:* memory reached 99% of the limit before each kill", "_prometheus_query_ `container_memory_working_set_bytes`"],
  ]);
});

// The finding ends in a backticked value of its own, which is the ordinary case — splitting on the
// last dash would move half the sentence into the Source column.
test("a backtick inside the finding does not become the source", () => {
  const [[finding, source]] = evidenceRows(
    "• the probe failed with `connection refused` on port `8080` — _k8s_describe_pod_ `ns/p-1`",
  );
  assert.equal(finding, "the probe failed with `connection refused` on port `8080`");
  assert.equal(source, "_k8s_describe_pod_ `ns/p-1`");
});

test("a line with no tool name keeps the whole sentence as the finding", () => {
  assert.deepEqual(evidenceRows("• nothing in the events mentions the image — checked twice"), [
    ["nothing in the events mentions the image — checked twice", ""],
  ]);
});

// Inline code is the reason the cells are rich_text: groundingGaps harvests candidate names from
// backticks, and the format rules require resource names to carry them.
test("code style survives into the cell, and an underscore inside it is not italics", () => {
  assert.deepEqual(toSpans("see `container_memory_working_set_bytes` now"), [
    { type: "text", text: "see " },
    { type: "text", text: "container_memory_working_set_bytes", style: { code: true } },
    { type: "text", text: " now" },
  ]);
});

test("bold and italic outside code are carried too", () => {
  assert.deepEqual(toSpans("*Fact:* read by _k8s_list_pods_"), [
    { type: "text", text: "Fact:", style: { bold: true } },
    { type: "text", text: " read by " },
    { type: "text", text: "k8s_list_pods", style: { italic: true } },
  ]);
});

test("the table carries a header row and one row per finding, both columns wrapped", () => {
  const table = evidenceTable(EVIDENCE) as unknown as { type: string; rows: unknown[][]; column_settings: unknown[] };
  assert.equal(table.type, "table");
  assert.equal(table.rows.length, 3, "header plus two findings");
  assert.deepEqual(table.rows[0], [
    { type: "raw_text", text: "Finding" },
    { type: "raw_text", text: "Source" },
  ]);
  assert.deepEqual(table.column_settings, [{ is_wrapped: true }, { is_wrapped: true }]);
});

// Falling back is the safe direction: a card Slack rejects takes the whole RCA with it.
test("anything that is not a list of findings keeps the bullet list", () => {
  assert.equal(evidenceTable("A paragraph of prose with no sources in it at all."), null, "prose");
  assert.equal(evidenceTable("• one finding — _k8s_list_pods_ `ns/p`"), null, "a single row");
  assert.equal(evidenceTable("• first thing\n• second thing"), null, "no sources anywhere");
  assert.equal(
    evidenceTable(`• ${"x".repeat(1600)} — _k8s_list_pods_ \`ns/p\`\n• b — _k8s_list_pods_ \`ns/p\``),
    null,
    "an oversized cell",
  );
});

// ---- Recommended Actions ---------------------------------------------------------------------

import { actionRows, actionsTable } from "./rca-tables.js";

const ACTIONS =
  "1. *Immediate:* set `gateway` to `ghcr.io/shop/checkout:1.8.2`, the tag the previous ReplicaSet is serving\n" +
  "2. *Short-term:* add a smoke test on the checkout path\n" +
  "3. *Long-term:* require an image-exists check in CI";

test("the rung becomes its own column and leaves the action text behind", () => {
  assert.deepEqual(actionRows(ACTIONS), [
    ["Immediate", "set `gateway` to `ghcr.io/shop/checkout:1.8.2`, the tag the previous ReplicaSet is serving"],
    ["Short-term", "add a smoke test on the checkout path"],
    ["Long-term", "require an image-exists check in CI"],
  ]);
});

// Three spellings down one column is the thing a table is supposed to fix, and the model writes
// all three.
test("the rung is normalised, not echoed", () => {
  const rows = actionRows("1. *short term:* a\n2. Short-Term: b\n3. **SHORT-TERM:** c");
  assert.deepEqual(rows.map(([w]) => w), ["Short-term", "Short-term", "Short-term"]);
});

test("a line with no rung keeps its text and an empty When", () => {
  assert.deepEqual(actionRows("1. *Immediate:* restart it\n2. then watch the dashboard for an hour"), [
    ["Immediate", "restart it"],
    ["", "then watch the dashboard for an hour"],
  ]);
});

test("the table is When plus Action, with only the action column wrapped", () => {
  const table = actionsTable(ACTIONS) as unknown as { type: string; rows: unknown[][]; column_settings: unknown[] };
  assert.equal(table.type, "table");
  assert.equal(table.rows.length, 4, "header plus three rungs");
  assert.deepEqual(table.rows[0], [
    { type: "raw_text", text: "When" },
    { type: "raw_text", text: "Action" },
  ]);
  // "Short-term" is the longest value this column can hold, so wrapping it can only break the word.
  assert.deepEqual(table.column_settings, [{ is_wrapped: false }, { is_wrapped: true }]);
});

test("a section with no rungs at all keeps the numbered list", () => {
  assert.equal(actionsTable("Restart the deployment and then watch it.\nEscalate if it recurs."), null);
  assert.equal(actionsTable("1. *Immediate:* the only one"), null, "a single row");
});
