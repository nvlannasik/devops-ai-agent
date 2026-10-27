import { test } from "node:test";
import assert from "node:assert/strict";
import { context, propagation, trace } from "@opentelemetry/api";
import { sqsTraceAttributes } from "./sqs.js";

// Before any SDK is registered: the API's no-op propagator writes nothing, so the helper must say
// "no attributes" — SendMessage stays exactly what it was before tracing existed.
test("with tracing off there are no message attributes at all", () => {
  assert.equal(sqsTraceAttributes(), undefined);
});

test("inside a span, the span's context is the traceparent attribute", async () => {
  const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
  const { TracerProvider } = await import("@opentelemetry/sdk-trace");
  trace.setGlobalTracerProvider(new TracerProvider());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  await trace.getTracer("t").startActiveSpan("chat", async (span) => {
    const attrs = sqsTraceAttributes();
    assert.equal(attrs?.traceparent?.DataType, "String");
    assert.match(attrs!.traceparent!.StringValue!, new RegExp(`^00-${span.spanContext().traceId}-${span.spanContext().spanId}-01$`));
    span.end();
  });
});
