import logger, { errDetail } from "../../utils/logger/index.js";
import { currentRouteContext, traceSuffix } from "../../utils/trace/index.js";
import type { ContentBlock, LLMClient, LLMResponse, Message, ToolDefinition } from "./types.js";

// A model echoing our own content-block JSON back as prose. Its meaning is NOT "the model is
// weak" — the garbled JSON once seen in Slack was our own bug (JSON.stringify over content
// blocks in toOpenAIMessages, since fixed). Today it means this backend's tool-call channel is
// dead: either our translation regressed, or the backend runs without a tool-call parser
// (e.g. vLLM without --enable-auto-tool-choice --tool-call-parser).
// Also used by agent/index.ts to log the same symptom on the final answer — one detector, so
// the two cannot drift apart.
export const SERIALIZED_BLOCKS = /^\s*\[\s*\{\s*"type"\s*:\s*"(text|tool_use)"/;

const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();

interface Failure {
  reason: string;
  toolChannelDead: boolean;
}

// Only deterministically detectable failures count. A weak-but-valid answer is not one:
// judging quality needs another LLM call and would not be trustworthy.
function failureOf(res: LLMResponse): Failure | null {
  // a tool round legitimately carries no text — treating it as empty would escalate every
  // single round of every investigation
  if (res.stopReason === "tool_use") return null;
  const text = textOf(res.content);
  if (!text) return { reason: `empty response (stop=${res.stopReason})`, toolChannelDead: false };
  if (SERIALIZED_BLOCKS.test(text)) return { reason: "serialized content blocks", toolChannelDead: true };
  return null;
}

export class RouterLLMClient implements LLMClient {
  constructor(
    private readonly backends: Map<string, LLMClient>,
    private readonly heavy: string[],
    private readonly light: string[],
    // backend name -> its configured model (registry.ts BackendSpec.model). Absent/undefined
    // for a backend with no configured model (e.g. private-llm) — chat() must pass that
    // through as undefined, never substitute another backend's model.
    private readonly models: Map<string, string | undefined> = new Map()
  ) {
    if (heavy.length === 0) throw new Error("router needs a non-empty heavy chain");
    for (const n of [...heavy, ...light]) {
      if (!backends.has(n)) throw new Error(`router route references unknown backend "${n}"`);
    }
  }

  // Failover is one-directional: light may escalate into heavy, heavy never descends into
  // light. Lateral failover between strong backends is preserved because that is not a
  // capability downgrade. Read docs/superpowers/specs/2026-07-30-llm-router-design.md §7
  // before making this bidirectional.
  private chain(): { names: string[]; route: "heavy" | "light" } {
    const ctx = currentRouteContext();
    if (!ctx || ctx.route === "heavy" || ctx.escalated) return { names: this.heavy, route: "heavy" };
    return { names: [...this.light, ...this.heavy], route: "light" };
  }

  async chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse> {
    const { names, route } = this.chain();
    const ctx = currentRouteContext();
    const failures: string[] = [];
    let last: unknown;

    for (const [i, name] of names.entries()) {
      const backend = this.backends.get(name)!;
      logger.info(`[llm-router] route=${route} backend=${name} attempt=${i + 1}/${names.length}${traceSuffix()}`);
      try {
        const res = await backend.chat(messages, tools, systemPrompt);
        const failure = failureOf(res);
        if (!failure) {
          // sticky only when we actually crossed into the heavy tier, not on a lateral hop
          if (route === "light" && i >= this.light.length && ctx) ctx.escalated = true;
          return { ...res, backend: name, route, model: this.models.get(name) };
        }
        if (failure.toolChannelDead) {
          logger.warn(
            `[llm-router] backend=${name} returned serialized content blocks — its tool-call ` +
            `channel is not working. Check the backend's tool-call parser (vLLM: ` +
            `--enable-auto-tool-choice --tool-call-parser) and toOpenAIMessages${traceSuffix()}`
          );
        } else {
          logger.warn(`[llm-router] backend=${name} failed: ${failure.reason}${traceSuffix()}`);
        }
        failures.push(`${name}: ${failure.reason}`);
        last = new Error(`${name}: ${failure.reason}`);
      } catch (err) {
        logger.warn(`[llm-router] backend=${name} threw: ${errDetail(err)}${traceSuffix()}`);
        failures.push(`${name}: ${errDetail(err)}`);
        last = err;
      }
    }

    logger.error(`[llm-router] all backends failed on the ${route} chain${traceSuffix()}`);
    throw new Error(`all LLM backends failed — ${failures.join("; ")}`, { cause: last });
  }

  // SQSLLMClient.shutdown() stops its dispatcher and deletes its queue. allSettled so one
  // failing backend cannot leak the others' queues on every restart.
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.backends.values()].map((b) => b.shutdown?.())
    );
    for (const r of results) {
      if (r.status === "rejected") logger.warn(`[llm-router] backend shutdown failed: ${errDetail(r.reason)}`);
    }
  }
}
