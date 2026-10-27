import { test } from "node:test";
import assert from "node:assert/strict";
import { SqsMcpDispatcher, SqsMCPClient } from "./sqs-client.js";
import { parseSqsClusters } from "../../config/index.js";

// The same contract keys are pinned in devops-mcp-server/src/app/sqs-bridge.test.ts (CONTRACT_REQUEST).
const CONTRACT_REQUEST_KEYS = ["args", "deadline", "op", "requestId", "tool"]; // + traceId inside an investigation

function fakeSqs(answer: (req: any) => any | null) {
  const sent: any[] = [];
  const released: string[] = [];
  const deleted: string[] = [];
  const inbox: any[] = [];
  return {
    sent, released, deleted, inbox,
    sqs: {
      send: async (cmd: any) => {
        const kind = cmd.constructor.name;
        if (kind === "GetQueueUrlCommand") return { QueueUrl: `https://q/${cmd.input.QueueName}` };
        if (kind === "SendMessageCommand") {
          const body = JSON.parse(cmd.input.MessageBody);
          sent.push({ url: cmd.input.QueueUrl, input: cmd.input, body });
          const a = answer(body);
          if (a) inbox.push({ Body: JSON.stringify(a), ReceiptHandle: `rh-${sent.length}`, Attributes: { ApproximateReceiveCount: "1" } });
          return {};
        }
        if (kind === "ReceiveMessageCommand") {
          await new Promise((r) => setTimeout(r, 5));
          return { Messages: inbox.splice(0) };
        }
        if (kind === "DeleteMessageCommand") { deleted.push(cmd.input.ReceiptHandle); return {}; }
        if (kind === "ChangeMessageVisibilityCommand") { released.push(cmd.input.ReceiptHandle); return {}; }
        return {};
      },
      destroy() {},
    },
  };
}

test("callTool: one send to the cluster's queue, contract shape, the routed content returned", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, response: { content: '[{"name":"web-1"}]', isError: false } }));
  const d = new SqsMcpDispatcher("devops-mcp-response.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "devops-mcp-lab2-request.fifo", d, { callTimeoutMs: 2000 });
  const before = Date.now();
  const out = await c.callTool("k8s_list_pods", { namespace: "sample-apps" });
  assert.equal(out, '[{"name":"web-1"}]');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, "https://q/devops-mcp-lab2-request.fifo");
  assert.deepEqual(Object.keys(f.sent[0].body).filter((k) => k !== "traceId").sort(), CONTRACT_REQUEST_KEYS);
  assert.equal(f.sent[0].body.op, "call_tool");
  assert.ok(f.sent[0].body.deadline >= before + 2000);
  assert.equal(f.sent[0].input.MessageGroupId, f.sent[0].body.requestId);
  assert.equal(f.sent[0].input.MessageDeduplicationId, f.sent[0].body.requestId);
  await d.shutdown();
});

test("no answer: throws the bridge timeout, and never retries", async () => {
  const f = fakeSqs(() => null);
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 50 });
  await assert.rejects(c.callTool("k8s_restart_deployment", { name: "web" }), /bridge lab2 did not answer within 0\.05s/);
  assert.equal(f.sent.length, 1, "a retry over SQS is a second request — a write would run twice");
  await d.shutdown();
});

test("a transport error from the bridge throws with its message", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, error: "expired" }));
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 2000 });
  await assert.rejects(c.callTool("k8s_list_pods", {}), /bridge lab2: expired/);
  await d.shutdown();
});

test("an isError result returns as text, the way MCPClient returns it", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, response: { content: "Error: pods is forbidden", isError: true } }));
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 2000 });
  assert.equal(await c.callTool("k8s_list_pods", {}), "Error: pods is forbidden");
  await d.shutdown();
});

test("a message for another replica is released; a late reply to our own timed-out request is deleted", async () => {
  const f = fakeSqs(() => null);
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "q.fifo", d, { callTimeoutMs: 30 });
  await assert.rejects(c.callTool("k8s_list_pods", {}));
  const ours = f.sent[0].body.requestId;
  f.inbox.push({ Body: JSON.stringify({ requestId: "someone-else", response: { content: "x" } }), ReceiptHandle: "rh-other", Attributes: { ApproximateReceiveCount: "1" } });
  f.inbox.push({ Body: JSON.stringify({ requestId: ours, response: { content: "late" } }), ReceiptHandle: "rh-late", Attributes: { ApproximateReceiveCount: "1" } });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(f.released.includes("rh-other"));
  assert.ok(f.deleted.includes("rh-late"));
  assert.ok(!f.released.includes("rh-late"));
  await d.shutdown();
});

test("connect caches the bridge's tools; an unreachable bridge leaves no tools and does not throw", async () => {
  const tools = [{ name: "k8s_list_pods", description: "list", inputSchema: {} }];
  const up = fakeSqs((req) => (req.op === "list_tools" ? { requestId: req.requestId, response: { tools } } : null));
  const d1 = new SqsMcpDispatcher("r.fifo", up.sqs, 1);
  const c1 = new SqsMCPClient("lab2", "q.fifo", d1, { listTimeoutMs: 2000, refreshMs: 60_000 });
  await c1.connect();
  assert.deepEqual(c1.getTools(), tools);
  await c1.disconnect();
  await d1.shutdown();

  const down = fakeSqs(() => null);
  const d2 = new SqsMcpDispatcher("r.fifo", down.sqs, 1);
  const c2 = new SqsMCPClient("prd", "q.fifo", d2, { listTimeoutMs: 30, refreshMs: 60_000 });
  await c2.connect();
  assert.deepEqual(c2.getTools(), []);
  await c2.disconnect();
  await d2.shutdown();
});

test("an explicit deadline is sent as given (the probe's --expired)", async () => {
  const f = fakeSqs((req) => ({ requestId: req.requestId, error: "expired" }));
  const d = new SqsMcpDispatcher("r.fifo", f.sqs, 1);
  await assert.rejects(d.request("q.fifo", { op: "list_tools" }, 2000, "lab2", { deadline: 123 }), /expired/);
  assert.equal(f.sent[0].body.deadline, 123);
  await d.shutdown();
});

test("parseSqsClusters: name=queue pairs; unset is none; malformed fails boot", () => {
  assert.deepEqual(parseSqsClusters(undefined), []);
  assert.deepEqual(parseSqsClusters(" "), []);
  assert.deepEqual(parseSqsClusters("lab2=devops-mcp-lab2-request.fifo, prd=devops-mcp-prd-request.fifo"), [
    { name: "lab2", requestQueueName: "devops-mcp-lab2-request.fifo" },
    { name: "prd", requestQueueName: "devops-mcp-prd-request.fifo" },
  ]);
  assert.throws(() => parseSqsClusters("lab2"), /MCP_SQS_CLUSTERS/);
  assert.throws(() => parseSqsClusters("lab2=q-not-fifo"), /\.fifo/);
  assert.throws(() => parseSqsClusters("Lab_2=q.fifo"), /name/);
  assert.throws(() => parseSqsClusters("a=q1.fifo,a=q2.fifo"), /duplicate/);
});

test("tracing: the request carries the caller's traceparent, the dispatcher's polls belong to no trace", async () => {
  const { context, propagation, trace } = await import("@opentelemetry/api");
  const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
  const { TracerProvider } = await import("@opentelemetry/sdk-trace");
  trace.setGlobalTracerProvider(new TracerProvider());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const f = fakeSqs((req) => ({ requestId: req.requestId, response: { content: "ok", isError: false } }));
  const pollParents: Array<string | undefined> = [];
  const send = f.sqs.send;
  f.sqs.send = async (cmd: any) => {
    if (cmd.constructor.name === "ReceiveMessageCommand") pollParents.push(trace.getActiveSpan()?.spanContext().traceId);
    return send(cmd);
  };
  const d = new SqsMcpDispatcher("devops-mcp-response.fifo", f.sqs, 1);
  const c = new SqsMCPClient("lab2", "devops-mcp-lab2-request.fifo", d, { callTimeoutMs: 2000 });
  let traceId = "";
  try {
    await trace.getTracer("t").startActiveSpan("execute_tool", async (span) => {
      traceId = span.spanContext().traceId;
      await c.callTool("k8s_list_pods", {});
      span.end();
    });
    assert.match(f.sent[0].input.MessageAttributes?.traceparent?.StringValue ?? "", new RegExp(`^00-${traceId}-`));
    assert.ok(pollParents.length > 0);
    assert.deepEqual([...new Set(pollParents)], [undefined], "no poll ran inside the caller's trace");
  } finally {
    await d.shutdown();
  }
});
