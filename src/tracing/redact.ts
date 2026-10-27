import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";

// The query string is where the content is (the mcp-server's PromQL/LogQL is the measured case),
// and the http/undici instrumentations record it in url.full. Jaeger's UI is a published surface
// (spec 2026-10-27-otel-tracing-design §5), so the query is cut before export.
// Paths stay — `/api/v1/namespaces/x/pods` is the part worth reading.
const URL_KEYS = ["url.full", "http.url", "http.target"] as const;

/** Rewrites URL attributes while the span is still writable. Registered ahead of the exporter. */
export class UrlQueryRedactor implements SpanProcessor {
  onStart(_span: Span, _ctx: Context): void {}

  onEnding(span: Span): void {
    const attrs = span.attributes;
    for (const key of URL_KEYS) {
      const v = attrs[key];
      if (typeof v === "string" && v.includes("?")) span.setAttribute(key, v.slice(0, v.indexOf("?")));
    }
    if (attrs["url.query"] !== undefined) span.setAttribute("url.query", "");
  }

  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
