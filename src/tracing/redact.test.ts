import { test } from "node:test";
import assert from "node:assert/strict";
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { UrlQueryRedactor } from "./redact.js";

const setup = () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new UrlQueryRedactor(), new SimpleSpanProcessor({ exporter })] });
  return { exporter, tracer: provider.getTracer("t") };
};

test("URL attributes lose their query string before export", () => {
  const { exporter, tracer } = setup();
  const span = tracer.startSpan("GET");
  span.setAttributes({
    "url.full": "http://p:9090/api/v1/query?query=sum(rate(x[5m]))",
    "http.url": "http://p:9090/api/v1/query?query=sum(rate(x[5m]))",
    "http.target": "/api/v1/query?query=sum(rate(x[5m]))",
    "url.query": "query=sum(rate(x[5m]))",
  });
  span.end();
  const a = exporter.getFinishedSpans()[0]!.attributes;
  assert.equal(a["url.full"], "http://p:9090/api/v1/query");
  assert.equal(a["http.url"], "http://p:9090/api/v1/query");
  assert.equal(a["http.target"], "/api/v1/query");
  assert.equal(a["url.query"], "");
});

test("a span without URL attributes is exported unchanged", () => {
  const { exporter, tracer } = setup();
  const span = tracer.startSpan("work");
  span.setAttributes({ "k8s.namespace.name": "prod", "url.path": "/api/v1/namespaces/prod/pods" });
  span.end();
  assert.deepEqual(exporter.getFinishedSpans()[0]!.attributes, { "k8s.namespace.name": "prod", "url.path": "/api/v1/namespaces/prod/pods" });
});
