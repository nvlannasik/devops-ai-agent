import { SpanKind, SpanStatusCode, isSpanContextValid, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { LLMResponse } from "../agent/llm/types.js";

// The agent's own spans, opened at the seams the harness trace already uses (runner.run,
// instrumentLLM, instrumentMCP, TraceRecorder.gate) so no call site changes. Metadata only: Jaeger's
// UI is a published surface (spec 2026-10-27-otel-tracing-design §5). src/tracing/spans.test.ts
// runs a real investigation and fails on any attribute outside this list or carrying content.
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "slack.thread_ts",
  "agent.run_mode",
  "agent.source",
  "agent.delegate",
  "alert.namespace",
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.tool.name",
  "llm.backend",
  "llm.route",
  "tool.result.chars",
  "gate.name",
  "gate.outcome",
]);

const tracer = () => trace.getTracer("devops-ai-agent");

/** Ends `span` around `fn`: ERROR on a throw (no message — an error can quote what it read), rethrown unchanged. */
async function run<T>(span: Span, fn: () => Promise<T>, onOk?: (value: T) => void): Promise<T> {
  try {
    const value = await fn();
    onOk?.(value);
    return value;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

/**
 * One investigation run. A top-level run (depth 0) is a new trace — an alert's webhook acked
 * before the run started — linked to whatever span was active when it began; a delegate (depth > 0)
 * is a child of its parent's investigation.
 */
export function withInvestigateSpan<T>(
  threadTs: string,
  o: { mode: string; depth: number; namespace: string | null; source: string },
  fn: () => Promise<T>
): Promise<T> {
  const top = o.depth === 0;
  const active = trace.getActiveSpan();
  const attributes: Attributes = { "slack.thread_ts": threadTs, "agent.run_mode": o.mode, "agent.source": o.source };
  if (o.namespace) attributes["alert.namespace"] = o.namespace;
  if (!top) attributes["agent.delegate"] = true;
  return tracer().startActiveSpan(
    "investigate",
    { kind: SpanKind.INTERNAL, root: top, links: top && active ? [{ context: active.spanContext() }] : [], attributes },
    (span) => run(span, fn)
  );
}

/**
 * One remediation proposal (the harness's "proposal" phase): its chat calls, guard reads and
 * dry-run under one span. A new trace, like a top-level investigation — the RCA's span has
 * already ended — found beside it in Jaeger by the same slack.thread_ts.
 */
export function withProposalSpan<T>(threadTs: string | null, fn: () => Promise<T>): Promise<T> {
  const active = trace.getActiveSpan();
  return tracer().startActiveSpan(
    "propose_remediation",
    {
      kind: SpanKind.INTERNAL,
      root: true,
      links: active ? [{ context: active.spanContext() }] : [],
      attributes: threadTs ? { "slack.thread_ts": threadTs } : {},
    },
    (span) => run(span, fn)
  );
}

/** One chat() call (OTel GenAI conventions). The model is only known from the response, so the span is renamed then. */
export function withChatSpan(fn: () => Promise<LLMResponse>): Promise<LLMResponse> {
  return tracer().startActiveSpan("chat", { kind: SpanKind.CLIENT, attributes: { "gen_ai.operation.name": "chat" } }, (span) =>
    run(span, fn, (r) => {
      if (r.model) {
        span.updateName(`chat ${r.model}`);
        span.setAttribute("gen_ai.request.model", r.model);
      }
      if (r.usage) {
        span.setAttribute("gen_ai.usage.input_tokens", r.usage.inputTokens);
        span.setAttribute("gen_ai.usage.output_tokens", r.usage.outputTokens);
      }
      if (r.backend) span.setAttribute("llm.backend", r.backend);
      if (r.route) span.setAttribute("llm.route", r.route);
    })
  );
}

/** One MCP tool call: its name and the size of what came back — never its arguments or its result. */
export function withToolSpan(name: string, fn: () => Promise<string>): Promise<string> {
  return tracer().startActiveSpan(
    `execute_tool ${name}`,
    { kind: SpanKind.CLIENT, attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name } },
    (span) => run(span, fn, (result) => span.setAttribute("tool.result.chars", result.length))
  );
}

/** A gate decision, as an event on the current investigation span: its name and outcome, never its detail. */
export function gateEvent(name: string, outcome: string): void {
  trace.getActiveSpan()?.addEvent("gate", { "gate.name": name, "gate.outcome": outcome });
}

/** The active span's trace id — what the dashboard links to Jaeger — or null with tracing off. */
export function currentOtelTraceId(): string | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && isSpanContextValid(ctx) ? ctx.traceId : null;
}
