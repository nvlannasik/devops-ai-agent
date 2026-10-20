import logger from "../../utils/logger/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { capConfidence, admitsLogGap, parseConfidence } from "../confidence/index.js";
import { stripTemplateEcho } from "../template-echo/index.js";
import { stripFabricatedNote } from "../fabricated-note/index.js";
import { stripMutatingCommands } from "../runbook/index.js";
import { stripOffer } from "../remediation/proposal.js";
import type { TraceRecorder } from "../trace/index.js";
import type { RunCtx, RunState } from "./run-state.js";

/**
 * Every exit from the investigation loop goes through here, so the footer is never missing from the
 * paths that matter most — the timeout and the out-of-steps replies are exactly where a reader wants
 * to know how long it ran and on which model. It reads `s` when CALLED: the counters are the run's
 * final ones, not the ones at the start.
 */
export function finalizeAnswer(ctx: RunCtx, s: RunState, trace: TraceRecorder, text: string): string {
  const durationMs = Date.now() - ctx.startedAt;
  ctx.opts.onComplete?.({
    durationMs,
    rounds: s.iterations,
    toolCalls: s.totalToolCalls,
    backend: s.lastResponse?.backend,
    model: s.lastResponse?.model,
    route: s.lastResponse?.route,
  });
  logger.info(
    `[${ctx.threadId}] Investigation complete in ${durationMs}ms (${s.iterations} LLM calls, ` +
    `${s.totalToolCalls} tool calls) | total tokens — ` +
    (s.totalUsage.inputTokens === 0 && s.totalUsage.outputTokens === 0
      // Not "zero tokens" — the agent-builder/Langflow envelope reports no counts at all
      // (devops-ai-agent-worker/src/agent-builder.ts), and printing in=0 out=0 cache_read=0
      // read as "prompt caching is broken" for weeks when the truth was "not measurable here".
      ? `not reported by ${s.lastResponse?.backend ?? "this backend"}`
      : `in=${s.totalUsage.inputTokens} out=${s.totalUsage.outputTokens} ` +
        `cache_read=${s.totalUsage.cacheReadTokens} cache_write=${s.totalUsage.cacheCreationTokens}`)
  );
  // An answer that says it could not read the logs cannot also be highly confident — see
  // capConfidence. Here, so the alert path and a mention both pass through it.
  const { text: rated, capped } = capConfidence(text, s.sawLogLines);
  if (capped) {
    logger.info(`[${ctx.threadId}] capped Confidence: High → Medium — the answer reports no logs`);
    trace.gate(ctx.threadId, "confidence-cap", "capped");
  } else if (parseConfidence(text) === "high") {
    // Bench C03 attempt 1, 2026-09-24: every log result came back under LOG_RESULT_MIN_CHARS,
    // and the stored answer matches admitsLogGap when tested offline — both conditions looked
    // met, and the cap still declined. The artifacts could not say which input differed,
    // because neither was ever written down. One line, only on a High rating, settles the next.
    // Settled 2026-09-29 by this very line (sawLogLines=true): a memoised repeat call, measured
    // WITH its repeat notice — see REPEAT_PREFIX.
    logger.info(
      `[${ctx.threadId}] Confidence: High kept — sawLogLines=${s.sawLogLines} admitsLogGap=${admitsLogGap(text)}`
    );
    trace.gate(ctx.threadId, "confidence-cap", "kept-high", `sawLogLines=${s.sawLogLines}`);
  }
  // A placeholder the model labelled instead of filling — see stripTemplateEcho. Done here
  // rather than in the Slack renderer: the same text reaches Postgres and the next
  // investigation's recall block, and "[Symptom]" is no more readable in either of those.
  const { text: filled, dropped } = stripTemplateEcho(rated);
  if (dropped > 0) {
    logger.info(`[${ctx.threadId}] dropped ${dropped} echoed template placeholder(s) from the answer`);
    trace.gate(ctx.threadId, "template-echo", "dropped", "", { count: dropped });
  }
  // A `[system note]` the MODEL wrote — see stripFabricatedNote. Here rather than in the Slack
  // renderer for two reasons: the same text is what the proposal step reads as its evidence, and
  // a fabricated "already executed" is exactly what makes it answer {"action": null}; and it
  // also reaches Postgres and the next investigation's recall, where a false lifecycle fact is
  // worse than an unreadable one. Logged at warn, not info: every other scrubber here is fixing
  // formatting, this one caught the answer claiming work it never did.
  const { text: honest, dropped: notes } = stripFabricatedNote(filled);
  if (notes > 0) {
    logger.warn(
      `[${ctx.threadId}] dropped ${notes} fabricated [system note] line(s) — the answer claimed an execution that never happened`
    );
    trace.gate(ctx.threadId, "fabricated-note", "dropped", "", { count: notes });
  }
  // A Runbook command that would CHANGE something, or is not a command a human can run (our own
  // tool calls, 2026-09-29) — see agent/runbook. Warn, like the note above.
  const { text: readOnly, dropped: commands } = stripMutatingCommands(honest);
  if (commands.length > 0) {
    logger.warn(
      `[${ctx.threadId}] dropped ${commands.length} Runbook line(s) that are not a read-only kubectl/helm/flux command: ` +
      truncate(commands.join(" | "), 300)
    );
    trace.gate(ctx.threadId, "runbook", "dropped", truncate(commands.join(" | "), 300), { count: commands.length });
  }
  // The [OFFER] line is for the gate, never for a reader. Thread memory already holds the raw
  // reply (appended above), which is where app/index.ts reads it back — see parseOffer.
  const answer = stripOffer(readOnly);
  if (answer !== readOnly) trace.gate(ctx.threadId, "offer", "stripped");
  trace.end(ctx.threadId, { answer, ms: durationMs, llmCalls: s.iterations, toolCalls: s.totalToolCalls });
  return answer;
}
