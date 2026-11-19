import { test } from "node:test";
import assert from "node:assert/strict";
import { DIALOG_HASH, nextTab, toolMatches } from "./tool-dialogs.js";

test("the filter matches name or description, case-insensitively; empty matches all", () => {
  assert.equal(toolMatches("k8s_get_pod_logs get logs from a pod container.", "LOGS"), true);
  assert.equal(toolMatches("k8s_list_nodes list all nodes", "logs"), false);
  assert.equal(toolMatches("anything", "   "), true);
});

test("tab keys wrap with the arrows, jump with Home/End, and leave other keys alone", () => {
  assert.equal(nextTab(0, "ArrowDown", 3), 1);
  assert.equal(nextTab(2, "ArrowDown", 3), 0);
  assert.equal(nextTab(0, "ArrowUp", 3), 2);
  assert.equal(nextTab(1, "Home", 3), 0);
  assert.equal(nextTab(1, "End", 3), 2);
  assert.equal(nextTab(1, "Enter", 3), null);
  assert.equal(nextTab(0, "ArrowDown", 0), null);
});

test("only a family hash opens a dialog", () => {
  assert.equal(DIALOG_HASH.exec("#cap-3")?.[1], "cap-3");
  assert.equal(DIALOG_HASH.exec("#tools"), null);
  assert.equal(DIALOG_HASH.exec("#cap-3x"), null);
});
