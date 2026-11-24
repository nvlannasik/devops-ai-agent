import logger, { errDetail } from "../../utils/logger/index.js";
import { config } from "../../config/index.js";
import { currentRouteContext, traceSuffix } from "../../utils/trace/index.js";
import type { ContentBlock, LLMClient, LLMResponse, Message, ToolDefinition } from "./types.js";
import { AllBackendsFailedError, classifyFailure, oneLine, type BackendFailure } from "./failure.js";

// A model echoing our own content-block JSON back as prose. Its meaning is NOT "the model is
// weak" — the garbled JSON once seen in Slack was our own bug (JSON.stringify over content
// blocks in toOpenAIMessages, since fixed). Today it means this backend's tool-call channel is
// dead: either our translation regressed, or the backend runs without a tool-call parser
// (e.g. vLLM without --enable-auto-tool-choice --tool-call-parser).
// Also used by agent/index.ts to log the same symptom on the final answer — one detector, so
// the two cannot drift apart.
export const SERIALIZED_BLOCKS = /^\s*\[\s*\{\s*"type"\s*:\s*"(text|tool_use)"/;

// A third shape of the same dead channel: the model writes the calls it meant to make as an
// OpenAI-style `{"tool_calls":[…]}` object in its TEXT, optionally fenced, and stops. Observed
// live 2026-10-22 from private-llm-agus — malformed JSON at that — and shipped to Slack, because
// it was neither of the two shapes above. Anchored at the start, so prose that mentions
// `tool_calls` is left alone. Never parsed and run: a call the model wrote as prose is not a call.
export const TEXT_TOOL_CALLS = /^\s*(?:```(?:json)?\s*)?\{\s*"tool_calls"\s*:\s*\[/;

// Our own `[EVIDENCE READ AT] <iso> (unix N)` stamp (loop/control.ts evidenceStamp), copied back as
// the whole answer. Bench C11, 2026-11-14: the reply to "ya" was that one line, so the approved
// cordon never reached a card. The stamp sits in the history as a text block after every tool
// round; a small model answering a two-letter message imitated the last text it saw. Defined here,
// not imported, so the router does not depend on the loop.
export const ECHOED_STAMP = /^\s*\[EVIDENCE READ AT\][^\n]*\s*$/;

/**
 * Failures a retry cannot fix. Exhausted credit and a rejected key do not heal in 120 seconds,
 * and the default cool-off treats them as if they might: a bench run lost six attempts to
 * `429 You have no credits remaining`, re-asking the same dead backend every two minutes.
 *
 * Matched on the explicit wording, never on the status code alone: a bare 429 is ordinary rate
 * limiting, which IS transient and which a short cool-off handles correctly. Over-matching here
 * benches a working backend for half an hour, so the list stays narrow and literal.
 */
// `Insufficient Balance` / 402 is DeepSeek's wording for the same thing (2026-11-24): without it the
// router re-asked an empty account every two minutes.
const TERMINAL = /no credits remaining|insufficient_quota|insufficient credit|insufficient balance|payment required|\b402\b|quota exceeded|billing|invalid[ _]api[ _]key|unauthorized|401|403/i;

export const isTerminalFailure = (reason: string): boolean => TERMINAL.test(reason);

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
  if (TEXT_TOOL_CALLS.test(text)) return { reason: "tool calls written out as text", toolChannelDead: true };
  if (ECHOED_STAMP.test(text)) return { reason: "answered with the evidence stamp instead of an answer", toolChannelDead: false };
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
const TERMINAL_COOLOFF_FACTOR = 15; // 120s default becomes 30 minutes

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

  /**
   * Returns the cool-off it just started, or 0 when the backend is still under the threshold.
   * A terminal failure skips the threshold entirely — there is nothing to confirm about a
   * rejected key, and one more attempt only spends another request to be told the same thing.
   */
  failed(name: string, now = Date.now(), terminal = false): number {
    if (this.threshold <= 0) return 0;
    const n = (this.fails.get(name) ?? 0) + 1;
    this.fails.set(name, n);
    if (n < this.threshold && !terminal) return 0;
    // Long, but still finite: credits get topped up and keys get rotated, and a backend benched
    // for the life of the process would need a restart to come back.
    const cooloff = terminal ? this.cooloffMs * TERMINAL_COOLOFF_FACTOR : this.cooloffMs;
    this.skipUntil.set(name, now + cooloff);
    // Counter resets with the cool-off: the next failure after it expires starts a fresh window
    // rather than re-benching the backend on one strike forever.
    this.fails.delete(name);
    return cooloff;
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
    ),
    /** `credit`: a heavy chain whose every failure is credit/auth goes on to the light lane. `never`: up-only. */
    private readonly descend: "credit" | "never" = config.llm.routerDescend
  ) {
    if (heavy.length === 0) throw new Error("router needs a non-empty heavy chain");
    for (const n of [...heavy, ...light]) {
      if (!backends.has(n)) throw new Error(`router route references unknown backend "${n}"`);
    }
  }

  // Failover is up-only for QUALITY: light may escalate into heavy, and heavy never descends into
  // light because a backend answered badly — a weak model fails by answering confidently
  // (docs/superpowers/specs/2026-07-30-llm-router-design.md §7). It descends for one reason only,
  // since 2026-11-24 (`descend`): every heavy backend is out of credit or refuses its key. Both heavy
  // backends ran dry that morning and every alert failed while the light ones had credit. A backend
  // may sit in both lanes; the chain is deduped so each is still tried at most once per call.
  private chain(): { names: string[]; route: "heavy" | "light" } {
    const ctx = currentRouteContext();
    if (!ctx || ctx.route === "heavy" || ctx.escalated) return { names: this.heavy, route: "heavy" };
    return { names: [...this.light, ...this.heavy.filter((n) => !this.light.includes(n))], route: "light" };
  }

  /** The light backends a heavy chain may go on to when the heavy ones cannot be paid or authorised. */
  private descent(primary: string[], route: "heavy" | "light"): string[] {
    if (route !== "heavy" || this.descend === "never") return [];
    return this.light.filter((n) => !primary.includes(n));
  }

  async chat(messages: Message[], tools: ToolDefinition[], systemPrompt: string): Promise<LLMResponse> {
    const { names: primary, route } = this.chain();
    const fallback = this.descent(primary, route);
    const names = [...primary, ...fallback];
    const ctx = currentRouteContext();
    const failures: BackendFailure[] = [];
    let last: unknown;
    let descended: string | undefined;

    const usable = this.health.usable(names);
    for (const [i, name] of names.entries()) {
      if (i >= primary.length && descended === undefined) {
        // Into the light lane only when EVERY heavy failure was money or a key. A heavy backend that
        // timed out or answered badly says nothing about whether a weaker model should answer.
        const payable = failures.length > 0 && failures.every((f) => f.kind === "credit" || f.kind === "auth");
        if (!payable) break;
        const kinds = new Set(failures.map((f) => f.kind));
        descended = kinds.has("auth") && kinds.has("credit") ? "heavy out of credit / key refused" : kinds.has("auth") ? "heavy key refused" : "heavy out of credit";
        logger.warn(`[llm-router] every heavy backend is ${descended.replace("heavy ", "")} — descending to the light backends (${fallback.join(", ")})${traceSuffix()}`);
      }
      if (!usable.has(name)) {
        logger.info(`[llm-router] skipping backend=${name} — cooling off after repeated failures${traceSuffix()}`);
        // Say WHY it is cooling off, or a person reads "all backends failed" with nothing after it.
        const prev = this.lastFailure.get(name);
        failures.push(prev ? { ...prev, summary: `${prev.summary} (not retried yet)` } : { backend: name, kind: "unavailable", summary: "cooling off after repeated failures" });
        continue;
      }
      const backend = this.backends.get(name)!;
      logger.info(`[llm-router] route=${route} backend=${name} attempt=${i + 1}/${names.length}${traceSuffix()}`);
      try {
        let res = await backend.chat(messages, tools, systemPrompt);
        let failure = failureOf(res, tools);
        // A malformed ANSWER from the last backend there is gets one more ask before the whole
        // investigation is thrown away. Bench B04 and C08, 2026-11-12: three tool rounds of
        // evidence lost to one "tool calls written out as text", on a chain with nothing after it.
        // The answer is a sample, and the next one is usually well-formed — the same backend had
        // called tools properly on every round before. Never for a THROWN error: a timeout has
        // already cost its full wait, and a dead backend answers the same way twice. Never while
        // another backend is left: failing over is what the chain is for.
        // "Nothing left" within this backend's own lane: a descent is not a lateral failover, and a
        // malformed heavy answer never descends, so the light lane does not count as left for it.
        const lane = i < primary.length ? primary : names;
        if (failure && !lane.slice(i + 1).some((n) => usable.has(n))) {
          logger.warn(`[llm-router] backend=${name}: ${failure.reason} — nothing left to fail over to, asking it once more${traceSuffix()}`);
          res = await backend.chat(messages, tools, systemPrompt);
          failure = failureOf(res, tools);
        }
        if (!failure) {
          this.health.succeeded(name);
          // sticky only when we actually crossed into the heavy tier, not on a lateral hop
          if (route === "light" && i >= this.light.length && ctx) ctx.escalated = true;
          if (descended) return { ...res, backend: name, route: "light", model: this.models.get(name), descended };
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
        this.noteFailure(name, failure.reason);
        failures.push(this.remember({ backend: name, kind: classifyFailure(failure.reason), summary: oneLine(failure.reason) }));
        last = new Error(`${name}: ${failure.reason}`);
      } catch (err) {
        logger.warn(`[llm-router] backend=${name} threw: ${errDetail(err)}${traceSuffix()}`);
        this.noteFailure(name, errDetail(err));
        // One line per backend for whatever reads the message (Slack, via userFacingError); the
        // stack stays in the warn line above.
        failures.push(this.remember({ backend: name, kind: classifyFailure(errDetail(err)), summary: oneLine(err) }));
        last = err;
      }
    }

    logger.error(`[llm-router] all backends failed on the ${route} chain${traceSuffix()}`);
    throw new AllBackendsFailedError(route, failures, { cause: last });
  }

  /** The last way each backend failed — what a skipped (cooling-off) backend is reported with. */
  private readonly lastFailure = new Map<string, BackendFailure>();
  private remember(f: BackendFailure): BackendFailure {
    this.lastFailure.set(f.backend, f);
    return f;
  }

  private noteFailure(name: string, reason: string): void {
    const terminal = isTerminalFailure(reason);
    const cooloff = this.health.failed(name, Date.now(), terminal);
    if (cooloff > 0) {
      logger.warn(
        `[llm-router] backend=${name} benched for ${Math.round(cooloff / 1000)}s — ` +
        (terminal ? `credentials or quota, which a retry cannot fix` : `${config.llm.routerFailureThreshold} consecutive failures`) +
        traceSuffix()
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
