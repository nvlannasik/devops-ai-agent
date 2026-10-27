import { context, propagation } from "@opentelemetry/api";
import type { MessageAttributeValue } from "@aws-sdk/client-sqs";

/**
 * The active span's W3C context as SQS message attributes, for the three SendMessage calls (LLM,
 * GitOps, MCP bridge). Context rides as attributes, never in the body: the bodies are cross-repo
 * contracts and stay byte-identical. `undefined` when nothing was injected (tracing off), so the
 * SendMessage is exactly what it was before tracing existed. The consumers read `traceparent` /
 * `tracestate` (llm-worker and mcp-server, src/tracing/sqs.ts).
 */
export function sqsTraceAttributes(): Record<string, MessageAttributeValue> | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const entries = Object.entries(carrier);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, { DataType: "String", StringValue: v }]));
}
