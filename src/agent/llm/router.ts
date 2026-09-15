import logger, { errDetail } from "../../utils/logger/index.js";
import { config } from "../../config/index.js";
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

// The other shape of a dead tool channel, and the one a weak backend actually produces: the
// model NAMES the tool it should have called and stops. Observed live — "is there any unused
// resource we can terminate?" came back as the single string `k8s_find_unused_resources`,
// stop=end_turn, and shipped to Slack as the answer because non-empty prose that is not JSON
// looked like a valid reply.
//
// Exact match after stripping decoration, deliberately. A response whose ENTIRE text is a
// registered tool name is not a judgement call — no answer to any question is that string. The
// looser reading ("I'll use `x` to check") is left alone: telling a real sentence that mentions
// a tool from a failed call needs to weigh intent, and a wrong escalation costs a heavy call on
// every turn that happens to name a tool.
const DECORATION = /^[\s`'"*_(\[]+|[\s`'"*_.,:;!?)\]]+$/g;

export function namesToolOnly(text: string, tools: ToolDefinition[]): boolean {
  const bare = text.replace(DECORATION, "").toLowerCase();
  if (!bare) return false;
  return tools.some((t) => t.name.toLowerCase() === bare);
}

interface Failure {
  reason: string;
  toolChannelDead: boolean;
}

// Only deterministically detectable failures count. A weak-but-valid answer is not one:
// judging quality needs another LLM call and would not be trustworthy.
function failureOf(res: LLMResponse, tools: ToolDefinition[]): Failure | null {
  // a tool round legitimately carries no text — treating it as empty would escalate every
  // single round of every investigation
  if (res.stopReason === "tool_use") return null;
  const text = textOf(res.content);
  if (!text) return { reason: `empty response (stop=${res.stopReason})`, toolChannelDead: false };
  if (SERIALIZED_BLOCKS.test(text)) return { reason: "serialized content blocks", toolChannelDead: true };
  if (namesToolOnly(text, tools)) {
    return { reason: `answered with a tool name instead of calling it (${text.trim()})`, toolChannelDead: true };
  }
  return null;
}

/**
 * Per-backend failover memory, exported for the test.
 *
 * Without it the router forgets a failure the instant it routes around it: a light backend that
 * burned its full 240s SQS timeout was retried FIRST on the very next question, and paid the
 * 240s again. The chain always found an answer, so the only symptom was a five-minute reply.
 *
 * Deliberately per-PROCESS, not shared through Redis. A backend unreachable from one pod is
 * usually unreachable because of that pod — its network, its credentials, its queue consumer —
 * and benching it fleet-wide on one pod's evidence is a bigger failure than the one it prevents.
 */
export class BackendHealth {
  private readonly fails = new Map<string, number>();
  private readonly skipUntil = new Map<string, number>();

  constructor(
    private readonly threshold: number,
    private readonly cooloffMs: number
  ) {}

  /** A success clears the record entirely — half-open recovery needs no separate state. */
  succeeded(name: string): void {
    this.fails.delete(name);
    this.skipUntil.delete(name);
  }

  /** Returns the cool-off it just started, or 0 when the backend is still under the threshold. */
  failed(name: string, now = Date.now()): number {
    if (this.threshold <= 0) return 0;
    const n = (this.fails.get(name) ?? 0) + 1;
    this.fails.set(name, n);
    if (n < this.threshold) return 0;
    this.skipUntil.set(name, now + this.cooloffMs);
    // Counter resets with the cool-off: the next failure after it expires starts a fresh window
    // rather than re-benching the backend on one strike forever.
    this.fails.delete(name);
    return this.cooloffMs;
  }

  cooling(name: string, now = Date.now()): boolean {
    const until = this.skipUntil.get(name);
    if (until === undefined) return false;
    if (until > now) return true;
    this.skipUntil.delete(name);
    return false;
  }

  /**
   * Which of `names` to actually try. Never returns empty: if every candidate is cooling off,
   * the cool-off is ignored and all of them are tried. A degraded attempt beats a certain
   * failure, and "all backends failed" must mean they were asked.
   */
  usable(names: string[], now = Date.now()): Set<string> {
    const open = names.filter((n) => !this.cooling(n, now));
    return new Set(open.length > 0 ? open : names);
  }
}

export class RouterLLMClient implements LLMClient {
  constructor(
    private readonly backends: Map<string, LLMClient>,
    private readonly heavy: string[],
    private readonly light: string[],
    // backend name -> its configured model (registry.ts BackendSpec.model). Absent/undefined
    // for a backend with no configured model (e.g. private-llm) — chat() must pass that
    // through as undefined, never substitute another backend's model.
    private readonly models: Map<string, string | undefined> = new Map(),
    private readonly health: BackendHealth = new BackendHealth(
      config.llm.routerFailureThreshold,
      config.llm.routerCooloffMs
    )
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

    const usable = this.health.usable(names);
    for (const [i, name] of names.entries()) {
      if (!usable.has(name)) {
        logger.info(`[llm-router] skipping backend=${name} — cooling off after repeated failures${traceSuffix()}`);
        continue;
      }
      const backend = this.backends.get(name)!;
      logger.info(`[llm-router] route=${route} backend=${name} attempt=${i + 1}/${names.length}${traceSuffix()}`);
      try {
        const res = await backend.chat(messages, tools, systemPrompt);
        const failure = failureOf(res, tools);
        if (!failure) {
          this.health.succeeded(name);
          // sticky only when we actually crossed into the heavy tier, not on a lateral hop
          if (route === "light" && i >= this.light.length && ctx) ctx.escalated = true;
          return { ...res, backend: name, route, model: this.models.get(name) };
        }
        if (failure.toolChannelDead) {
          logger.warn(
            `[llm-router] backend=${name}: ${failure.reason} — its tool-call channel is not ` +
            `working. Check the backend's tool-call parser (vLLM: --enable-auto-tool-choice ` +
            `--tool-call-parser) and toOpenAIMessages${traceSuffix()}`
          );
        } else {
          logger.warn(`[llm-router] backend=${name} failed: ${failure.reason}${traceSuffix()}`);
        }
        this.noteFailure(name);
        failures.push(`${name}: ${failure.reason}`);
        last = new Error(`${name}: ${failure.reason}`);
      } catch (err) {
        logger.warn(`[llm-router] backend=${name} threw: ${errDetail(err)}${traceSuffix()}`);
        this.noteFailure(name);
        failures.push(`${name}: ${errDetail(err)}`);
        last = err;
      }
    }

    logger.error(`[llm-router] all backends failed on the ${route} chain${traceSuffix()}`);
    throw new Error(`all LLM backends failed — ${failures.join("; ")}`, { cause: last });
  }

  private noteFailure(name: string): void {
    const cooloff = this.health.failed(name);
    if (cooloff > 0) {
      logger.warn(
        `[llm-router] backend=${name} benched for ${Math.round(cooloff / 1000)}s after ` +
        `${config.llm.routerFailureThreshold} consecutive failures${traceSuffix()}`
      );
    }
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
