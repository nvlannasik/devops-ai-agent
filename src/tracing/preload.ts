// `node --import ./dist/src/tracing/preload.js dist/index.js` (Dockerfile CMD)
//
// Starts OpenTelemetry before the agent's own module graph loads. Two orderings matter, and both
// were measured (devops-sample-apps, 2026-10-27): the SDK started from index.ts instruments nothing,
// because an ESM entry's imports run before its body; and even started first, an ESM
// `import * as http` stays unpatched without OTel's import-in-the-middle hook. So: register the hook,
// THEN load the SDK and the instrumentations — dynamically, because a static import here would be
// evaluated before register() runs.
//
// With no OTEL_EXPORTER_OTLP_ENDPOINT nothing is registered or loaded: the service runs exactly as
// it did before tracing existed. Nothing here may throw into the service.
import { register } from "node:module";

const PROBES = new Set(["/health", "/healthz", "/ready", "/readyz", "/metrics"]);
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;

if (endpoint) {
  try {
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
    const [{ startTracing }, { HttpInstrumentation }, { UndiciInstrumentation }, { PgInstrumentation }, { IORedisInstrumentation }, { WinstonInstrumentation }] =
      await Promise.all([
        import("./index.js"),
        import("@opentelemetry/instrumentation-http"),
        import("@opentelemetry/instrumentation-undici"),
        import("@opentelemetry/instrumentation-pg"),
        import("@opentelemetry/instrumentation-ioredis"),
        import("@opentelemetry/instrumentation-winston"),
      ]);
    startTracing({
      service: process.env.OTEL_SERVICE_NAME || "devops-ai-agent",
      version: process.env.SERVICE_VERSION || "dev",
      environment: process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || "dev",
      endpoint,
      instrumentations: [
        // No header capture is configured: credential headers never become attributes.
        new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => PROBES.has((req.url ?? "").split("?")[0] ?? "") }),
        // fetch: the Anthropic/OpenAI-compatible clients and the MCP HTTP client.
        new UndiciInstrumentation(),
        // Statement text only — pg records the query, never its bound values.
        new PgInstrumentation(),
        new IORedisInstrumentation(),
        new WinstonInstrumentation(),
      ],
    });
  } catch (err) {
    console.warn(`[tracing] disabled — the preload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
