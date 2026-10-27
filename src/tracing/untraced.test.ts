import { test } from "node:test";
import assert from "node:assert/strict";
import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { untraced } from "./untraced.js";

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// A background loop started from inside a request inherits that request's context — every long poll
// after it lands in the first investigation's trace (2026-10-27: 102 SQS POSTs under one chat span,
// the trace 941s long). untraced() is the way out: no parent, and no spans at all.
test("work started inside a span runs with no parent and records nothing", async () => {
  exporter.reset();
  const tracer = trace.getTracer("t");
  await tracer.startActiveSpan("investigate", async (inv) => {
    await untraced(async () => {
      assert.equal(trace.getActiveSpan(), undefined, "no inherited span");
      tracer.startActiveSpan("poll", (s) => s.end());
      await new Promise((r) => setTimeout(r, 5));
      tracer.startActiveSpan("poll-after-await", (s) => s.end());
    });
    inv.end();
  });
  assert.deepEqual(exporter.getFinishedSpans().map((s) => s.name), ["investigate"]);
});
