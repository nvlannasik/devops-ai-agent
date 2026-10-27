import { ROOT_CONTEXT, context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

/**
 * Runs background work — a long-poll loop, a refresh timer — with no parent span and tracing
 * suppressed. A loop started lazily from inside a request inherits that request's context for its
 * whole life: on 2026-10-27 the LLM dispatcher, first started inside a `chat` span, hung 102 SQS
 * receive calls under it and stretched the first investigation's trace to 941s. Polls are not part of
 * any investigation; the requests they deliver carry their own context.
 */
export function untraced<T>(fn: () => T): T {
  return context.with(suppressTracing(ROOT_CONTEXT), fn);
}
