import { test } from "node:test";
import assert from "node:assert/strict";
import { lastToolResultIn } from "./index.js";
import type { Message } from "./llm/types.js";

// The cluster tour posts its tables from the tool's own result (utils/slack/tour-tables), so the app
// needs the latest k8s_cluster_inventory result of the thread — paired to its call by id, because a
// tool_result block does not carry the tool's name.
const use = (id: string, name: string, input: unknown = {}): Message => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] as any });
const result = (id: string, content: string): Message => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] as any });

test("the latest result of the named tool, paired by tool_use id", () => {
  const history: Message[] = [
    { role: "user", content: "jelasin cluster ini" },
    use("a", "k8s_cluster_inventory"), result("a", "first"),
    use("b", "k8s_list_pods"), result("b", "pods"),
    use("c", "k8s_cluster_inventory", { namespace: "x" }), result("c", "second"),
    { role: "assistant", content: "answer" },
  ];
  assert.equal(lastToolResultIn(history, "k8s_cluster_inventory"), "second");
  assert.equal(lastToolResultIn(history, "k8s_list_pods"), "pods");
});

test("no call of that tool in the thread is null, not another tool's result", () => {
  assert.equal(lastToolResultIn([use("b", "k8s_list_pods"), result("b", "pods")], "k8s_cluster_inventory"), null);
  assert.equal(lastToolResultIn([], "k8s_cluster_inventory"), null);
});
