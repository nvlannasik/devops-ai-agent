import { test } from "node:test";
import assert from "node:assert/strict";
import { runProbe } from "./probe.js";
import { config } from "../../config/index.js";

function withClusters<T>(clusters: Array<{ name: string; requestQueueName: string }>, fn: () => Promise<T>): Promise<T> {
  const prev = config.mcp.sqs.clusters;
  (config.mcp.sqs as any).clusters = clusters;
  return fn().finally(() => { (config.mcp.sqs as any).clusters = prev; });
}

function fakeDispatcher(answer: () => Promise<any>) {
  const calls: any[] = [];
  return {
    calls,
    d: {
      request: async (q: string, msg: any, t: number, l: string, o: any = {}) => { calls.push({ q, msg, t, l, o }); return answer(); },
      shutdown: async () => {},
    } as any,
  };
}

test("unknown cluster: exit 2 and the registered names", async () => {
  const errs: string[] = [];
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () => runProbe(["prd"], { err: (s) => errs.push(s), out: () => {} }));
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /lab2/);
});

test("no tool: list_tools, prints the names and count", async () => {
  const out: string[] = [];
  const f = fakeDispatcher(async () => ({ tools: [{ name: "k8s_list_pods", description: "", inputSchema: {} }] }));
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () => runProbe(["lab2"], { dispatcher: f.d, out: (s) => out.push(s), err: () => {} }));
  assert.equal(code, 0);
  assert.equal(f.calls[0].msg.op, "list_tools");
  assert.match(out.join("\n"), /1 tool/);
  assert.match(out.join("\n"), /k8s_list_pods/);
});

test("a tool with JSON args: call_tool to the cluster's queue; --expired sends a past deadline", async () => {
  const f = fakeDispatcher(async () => ({ content: "[]", isError: false }));
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () =>
    runProbe(["lab2", "k8s_list_pods", '{"namespace":"sample-apps"}', "--expired"], { dispatcher: f.d, out: () => {}, err: () => {} })
  );
  assert.equal(code, 0);
  assert.deepEqual(f.calls[0].msg, { op: "call_tool", tool: "k8s_list_pods", args: { namespace: "sample-apps" } });
  assert.equal(f.calls[0].q, "q.fifo");
  assert.ok(f.calls[0].o.deadline < Date.now());
});

test("an error from the bridge: exit 1 with the message", async () => {
  const errs: string[] = [];
  const f = fakeDispatcher(async () => { throw new Error("bridge lab2: expired"); });
  const code = await withClusters([{ name: "lab2", requestQueueName: "q.fifo" }], () => runProbe(["lab2"], { dispatcher: f.d, out: () => {}, err: (s) => errs.push(s) }));
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /expired/);
});
