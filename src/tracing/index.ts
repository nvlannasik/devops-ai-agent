import type { Instrumentation } from "@opentelemetry/instrumentation";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { UrlQueryRedactor } from "./redact.js";
import { setActiveTracing, type TracingHandle } from "./handle.js";

// Loaded by preload.ts AFTER the ESM loader hook is registered — never import this from a module
// the app loads first, or the SDK's own imports (node:http among them) bind before the hook.

export { activeTracing, type TracingHandle } from "./handle.js";

/**
 * Starts the SDK, or returns null — with no endpoint, or when start throws (logged once). Tracing
 * must never take the service down: an unreachable endpoint only drops spans.
 */
export function startTracing(opts: {
  service: string;
  version: string;
  environment: string;
  endpoint: string | null;
  instrumentations: Instrumentation[];
}): TracingHandle | null {
  if (!opts.endpoint) return null;
  try {
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": opts.service,
        "service.version": opts.version,
        "deployment.environment.name": opts.environment,
      }),
      spanProcessors: [
        new UrlQueryRedactor(),
        new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/+$/, "")}/v1/traces` }) }),
      ],
      instrumentations: opts.instrumentations,
    });
    sdk.start();
    const handle: TracingHandle = { shutdown: () => sdk.shutdown().catch(() => {}) };
    setActiveTracing(handle);
    return handle;
  } catch (err) {
    console.warn(`[tracing] disabled — the SDK did not start: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
