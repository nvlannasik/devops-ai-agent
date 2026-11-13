import logger from "../../utils/logger/index.js";
import { truncate } from "../../utils/truncate/index.js";
import { isRcaResponse } from "../../utils/slack/blocks.js";
import { SERIALIZED_BLOCKS, TEXT_TOOL_CALLS, namesToolOnly } from "../llm/router.js";
import type { LLMResponse } from "../llm/types.js";
import type { ConversationMemory } from "../memory/index.js";
import { observedText, groundingGaps } from "../grounding/index.js";
import { rcaGaps, rcaGapNotice } from "../rca-completeness/index.js";
import { imageGapRepo, IMAGE_GAP_NOTICE } from "../remediation/evidence-refusals.js";
import type { TraceRecorder } from "../trace/index.js";
import {
  extractText, needsEvidence, noToolRoundLeft, NO_EVIDENCE_NOTICE, FABRICATED_EVIDENCE_NOTICE,
  declinesAlert, ALERT_IN_SCOPE_NOTICE, alertDeclinedFallback,
} from "./control.js";
import { demandsLogs, logGapAction, LOG_GAP_NOTICE, nudgeLostRca } from "./log-gap.js";
import type { RunCtx, RunState } from "./run-state.js";

/** What the gates need from the agent: the thread's memory, the recorder (read live), and the
 *  playbook names — we put them in the model's context, so quoting one back is not an invention. */
export interface GateHost {
  readonly memory: ConversationMemory;
  readonly skills: { all(): ReadonlyArray<{ name: string }> };
  trace(): TraceRecorder;
}

/**
 * An RCA that names resources no tool result contained, held for one round before it leaves.
 *
 * `groundingGaps` already finds them, and until now only AFTER the answer was posted: a warning
 * beside an RCA that had already reached Slack, `incidents.root_cause` and the next recall. Bench
 * 2026-11-12, three of the six failed attempts: `postgres-primary.bench-a01.svc.cluster.local`
 * ("e.g.") and a Role `pod-lister` ("Example:") written into Recommended Actions as things to
 * create, and an Ingress `orders-api-ingress` with a hostname invented for the Impact section.
 * Every name this check has ever flagged in the bench is one of those two shapes: an example of
 * something to make, or a detail filled in around a real finding.
 *
 * The notice names them and gives both ways out — look it up, or take it out — so a successful
 * round may run tools or none. That is why it has its own slot rather than `heldBy`: neither "the
 * round ran no tools" nor "it ran some" says whether it worked. What says so is the same check run
 * again: the retry is taken only when it is still an RCA, lost no section, and names FEWER
 * ungrounded resources. Anything else returns the RCA it interrupted, which had already passed
 * every other gate.
 *
 * Only for a run whose caller handed over `opts.grounding` (the alert path) — the evidence has to
 * be the same text the after-the-fact warning uses, or the two disagree about what was seen.
 */
export const UNGROUNDED_NOTICE = (names: string[]): string =>
  `[UNGROUNDED NAMES — your answer names ${names.map((n) => `\`${n}\``).join(", ")} in backticks, and no tool ` +
  `result in this investigation, nor the alert, nor the change timeline contains ${names.length === 1 ? "it" : "them"}. A name in ` +
  `backticks is read as a real object in this cluster: it reaches the on-call, the incident record and ` +
  `the next investigation's recall. For each one, either call the tool that would show it and keep it ` +
  `only if it comes back, or take it out. An EXAMPLE of something to create — a Role, a Secret, a ` +
  `hostname — is not a resource: describe it in words ("a Role granting \`list\` on pods"), never as a ` +
  `name. Do not put another name you have not seen in its place. Then post the COMPLETE RCA again, ` +
  `every section in order — this reply replaces the previous one, so do not shorten what you wrote.]`;

async function groundedAnswer(h: GateHost, ctx: RunCtx, s: RunState, answer: string): Promise<string | null> {
  if (ctx.opts.grounding === undefined) return answer;
  // The same "given" as DevOpsAgent.ungroundedNames: the caller's evidence plus the playbook names.
  const given = [ctx.opts.grounding, ...h.skills.all().map((k) => k.name)].join("\n");
  const gapsOf = async (text: string) => groundingGaps(text, await h.memory.get(ctx.threadId), given);

  if (s.groundingHeld !== null) {
    const held = s.groundingHeld;
    s.groundingHeld = null;
    const [before, after] = [await gapsOf(held), await gapsOf(answer)];
    if (isRcaResponse(answer) && rcaGaps(answer).length <= rcaGaps(held).length && after.length < before.length) {
      logger.info(`[${ctx.threadId}] the grounding round left ${after.length} of ${before.length} ungrounded name(s)`);
      return answer;
    }
    logger.warn(
      `[${ctx.threadId}] the grounding round did not improve the RCA (${before.length} → ${after.length} ungrounded, ` +
      `${isRcaResponse(answer) ? "still an RCA" : "no longer an RCA"}) — keeping the earlier answer`
    );
    h.trace().resolveNudge(ctx.threadId, "kept-earlier");
    return held;
  }

  // Two calls must be left — the look-up and the answer — or the retry can end in the apology.
  const noRoom = noToolRoundLeft({ toolsDisabled: s.toolsDisabled, iterations: s.iterations, maxIterations: ctx.maxIterations });
  if (s.groundingNudged || noRoom || Date.now() > ctx.deadline || !isRcaResponse(answer)) return answer;
  const gaps = await gapsOf(answer);
  if (gaps.length === 0) return answer;
  s.groundingNudged = true;
  s.groundingHeld = answer;
  logger.info(`[${ctx.threadId}] RCA names ${gaps.length} resource(s) no tool result contained (${gaps.join(", ")}) — one more round`);
  h.trace().gate(ctx.threadId, "grounding", "nudge", gaps.join(", "));
  await h.memory.append(ctx.threadId, { role: "user", content: UNGROUNDED_NOTICE(gaps) });
  return null;
}

/**
 * The model stopped talking (end_turn or max_tokens): every gate that may hold the answer for one
 * more round runs here, in the order the loop always ran them. Returns the answer to finalise, or
 * null when a gate appended its notice and the loop must take another round. Moved out of
 * runInvestigation on 2026-10-21 without a change of order or wording.
 */
export async function settleAnswer(h: GateHost, ctx: RunCtx, s: RunState, response: LLMResponse): Promise<string | null> {
  const answer = await settle(h, ctx, s, response);
  if (answer === null) return null;
  // Whichever gate let it out — including a restore of the answer a nudge interrupted — the
  // out-of-scope line never leaves under an alert. See declinesAlert. Not while the grounding
  // gate holds an RCA: then the RCA is what leaves, and groundedAnswer returns it.
  if (s.groundingHeld === null && declinesAlert(ctx.mode, answer)) {
    logger.warn(`[${ctx.threadId}] the alert was answered with the out-of-scope line again — replacing it with a visible failure`);
    h.trace().gate(ctx.threadId, "scope-decline", "replaced", truncate(answer, 200));
    return alertDeclinedFallback(s.toolRounds);
  }
  // Last, on whatever is leaving: see groundedAnswer.
  return groundedAnswer(h, ctx, s, answer);
}

async function settle(h: GateHost, ctx: RunCtx, s: RunState, response: LLMResponse): Promise<string | null> {
  const summary = extractText(response.content);
  if (!summary) {
    // never return empty — Slack chat.postMessage rejects an empty text with `no_text`
    logger.warn(`[${ctx.threadId}] LLM returned an empty final response (stop=${response.stopReason})`);
    if (response.stopReason === "max_tokens") {
      // reasoning models can spend the entire output budget thinking and emit no text
      return "⚠️ The model hit its output-token limit before writing the answer (its reasoning consumed the whole budget). Try again — or raise `LLM_MAX_TOKENS` / set `LLM_REASONING_EFFORT=low` on the llm-worker.";
    }
    return "⚠️ The investigation finished but the model returned an empty response. Please re-run or rephrase the request.";
  }
  // A model that echoes our own content-block JSON as prose means its tool-call
  // channel is not working (see toOpenAIMessages in the OpenAI-compatible clients).
  // Log it here — otherwise the only symptom is a wall of JSON in Slack.
  if (SERIALIZED_BLOCKS.test(summary) || TEXT_TOOL_CALLS.test(summary)) {
    logger.warn(
      `[${ctx.threadId}] final answer looks like a serialized content array — the backend is likely ` +
      `not emitting native tool_calls (check the LLM tool-call parser). Preview: ${truncate(summary, 200)}`
    );
  }
  // The other shape of the same fault: the model named the tool instead of calling it.
  // The router escalates on this, so with LLM_PROVIDER=router it is already handled by
  // the time we get here — this branch is the backstop for the single-backend providers,
  // which have nothing to fall up to. Logged, not rewritten: a canned reply would hide a
  // misconfigured tool-call parser behind a friendly sentence.
  if (namesToolOnly(summary, s.toolsDisabled ? [] : ctx.tools)) {
    logger.warn(
      `[${ctx.threadId}] final answer is just the tool name \`${summary.trim()}\` — the backend named a ` +
      `tool instead of calling it. Check its tool-call parser; on LLM_PROVIDER=router this escalates instead.`
    );
  }
  // First of all: an alert answered with the out-of-scope line. Not held and never restored —
  // there is nothing in it to keep. Needs a call left to spend, like the completeness gate.
  // Not while the grounding gate holds an RCA: that RCA is the answer, not another round.
  if (!s.scopeDeclineNudged && s.groundingHeld === null && s.iterations < ctx.maxIterations && declinesAlert(ctx.mode, summary)) {
    s.scopeDeclineNudged = true;
    logger.warn(`[${ctx.threadId}] the alert was answered with the out-of-scope line after ${s.toolRounds} tool round(s) — one more round`);
    h.trace().gate(ctx.threadId, "scope-decline", "nudge", `after ${s.toolRounds} tool round(s)`);
    await h.memory.append(ctx.threadId, { role: "user", content: ALERT_IN_SCOPE_NOTICE });
    return null;
  }
  // Before every other gate: an alert answered with no tool call at all has not been
  // investigated, and whatever the other gates would ask about is downstream of that.
  const noFetch = noToolRoundLeft({ toolsDisabled: s.toolsDisabled, iterations: s.iterations, maxIterations: ctx.maxIterations });
  if (needsEvidence({ mode: ctx.mode, toolRounds: s.toolRounds, nudged: s.noEvidenceNudged, toolsDisabled: noFetch, answer: summary })) {
    s.noEvidenceNudged = true;
    s.preNudgeSummary = summary;
    s.toolRoundsAtNudge = s.toolRounds;
    logger.warn(
      `[${ctx.threadId}] answered with zero tool calls — one more round to go and look` +
      (ctx.mode === "alert" ? "" : " (the answer presented tool output it never fetched)")
    );
    h.trace().gate(ctx.threadId, "no-evidence", "nudge");
    await h.memory.append(ctx.threadId, {
      role: "user",
      content: ctx.mode === "alert" ? NO_EVIDENCE_NOTICE : FABRICATED_EVIDENCE_NOTICE,
    });
    return null;
  }
  // The last gate before an answer leaves — see logGapAction for all three outcomes.
  const gap = logGapAction({
    mode: ctx.mode,
    demandsLogs: demandsLogs(s.skills),
    sawLogLines: s.sawLogLines,
    nudged: s.logGapNudged,
    toolsDisabled: noFetch,
    toolRounds: s.toolRounds,
    toolRoundsAtNudge: s.toolRoundsAtNudge,
    heldBy: s.heldBy,
  });
  if (gap === "restore") {
    // Gate-agnostic on purpose: both gates hold their answer in the same slot, so this
    // sentence has to be true of whichever one spent the round.
    logger.warn(
      `[${ctx.threadId}] the extra round fetched nothing — keeping the pre-nudge answer ` +
      `(${s.preNudgeSummary.length} chars) over the retry's ${summary.length}`
    );
    h.trace().resolveNudge(ctx.threadId, "restored");
    return s.preNudgeSummary;
  }
  if (gap === "nudge") {
    s.logGapNudged = true;
    s.preNudgeSummary = summary;
    s.heldBy = "tools";
    s.toolRoundsAtNudge = s.toolRounds;
    logger.info(
      `[${ctx.threadId}] answered after ${s.toolRounds} tool round(s) with no log lines, while ` +
      `[${s.skills.map((s) => s.name).join(", ")}] read logs — one more round`
    );
    h.trace().gate(ctx.threadId, "log-gap", "nudge", `after ${s.toolRounds} tool round(s)`);
    await h.memory.append(ctx.threadId, { role: "user", content: LOG_GAP_NOTICE });
    return null;
  }
  if (nudgeLostRca({ mode: ctx.mode, heldBy: s.heldBy, before: s.preNudgeSummary, after: summary })) {
    logger.warn(
      `[${ctx.threadId}] the extra round replaced an RCA with something that is not one ` +
      `("${truncate(summary, 80)}") — keeping the RCA`
    );
    h.trace().gate(ctx.threadId, "nudge-lost-rca", "kept", truncate(summary, 200));
    h.trace().resolveNudge(ctx.threadId, "kept-earlier");
    return s.preNudgeSummary;
  }
  // Second gate, same hold slot: only one nudge may be outstanding, so this is reached only
  // when the log gap did not take the round. Evidence-driven, so it is safe in every mode —
  // the trigger is a pull failure in tool output, not a guess about the question.
  if (!s.imageGapNudged && !noFetch && s.toolRounds > 0) {
    const repo = imageGapRepo(summary, observedText(await h.memory.get(ctx.threadId)));
    if (repo) {
      s.imageGapNudged = true;
      s.preNudgeSummary = summary;
      s.heldBy = "tools";
      s.toolRoundsAtNudge = s.toolRounds;
      logger.info(`[${ctx.threadId}] answer names \`${repo}\` only as the image that failed to pull — one more round for the tag that works`);
      h.trace().gate(ctx.threadId, "image-gap", "nudge", repo);
      await h.memory.append(ctx.threadId, { role: "user", content: IMAGE_GAP_NOTICE });
      return null;
    }
  }
  // Third gate, same hold slot, and the only one that does NOT want another tool round —
  // see rca-completeness. The investigation is over; what is missing is writing. So it is
  // not gated on `toolsDisabled`: a tool-free turn is exactly the turn it asks for. It still
  // needs a call left to spend it on — on the last one the nudge fell out into the apology.
  if (!s.rcaGapNudged && s.iterations < ctx.maxIterations && ctx.mode === "alert" && isRcaResponse(summary)) {
    const missing = rcaGaps(summary);
    if (missing.length > 0) {
      s.rcaGapNudged = true;
      s.preNudgeSummary = summary;
      s.heldBy = "rca";
      s.toolRoundsAtNudge = s.toolRounds;
      logger.info(`[${ctx.threadId}] RCA is missing ${missing.join(", ")} — one more round to complete it`);
      h.trace().gate(ctx.threadId, "rca-completeness", "nudge", missing.join(", "));
      await h.memory.append(ctx.threadId, { role: "user", content: rcaGapNotice(missing) });
      return null;
    }
  }
  // The completion round replaces what it was given, so it can lose as well as gain. The
  // other gates decide that on whether the extra round ran any tools; this one can compare
  // the thing itself, which is the better test when it is available.
  if (s.rcaGapNudged && s.preNudgeSummary !== "" && rcaGaps(summary).length > rcaGaps(s.preNudgeSummary).length) {
    logger.warn(
      `[${ctx.threadId}] the completion round came back with more missing than it was given ` +
      `(${rcaGaps(summary).join(", ")}) — keeping the earlier answer`
    );
    h.trace().resolveNudge(ctx.threadId, "kept-earlier");
    return s.preNudgeSummary;
  }
  return summary;
}
