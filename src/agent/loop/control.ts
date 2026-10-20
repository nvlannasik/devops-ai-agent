import { type Skill } from "../skills/index.js";
import { citedNames } from "../grounding/index.js";
import { type ContentBlock, type Message } from "../llm/types.js";

export const MAX_ITERATIONS = 10;

// conversation mode: max distinct pods whose logs may be fetched in one round — a generic
// name matching many pods ("metallb" → 8) should produce a "which one?" question, not a dump
export const MAX_LOG_FANOUT = 2;

/** Conversation mode: the tool budget is spent. Answer, and stay out of RCA format. */
export const TOOL_BUDGET_NOTICE =
  "[TOOL BUDGET REACHED — compose your final answer now from the data above. Tool calls are disabled. " +
  "Reply in plain Slack mrkdwn — do NOT use the RCA incident format. If something looked anomalous, " +
  "mention it in one line and offer to investigate.]";

/**
 * Shared by the two hard ceilings below. They are reached differently and say so in their
 * opening clause, but their reader is the same — the alert path, whose answer IS the RCA — so
 * the instruction has to be identical and is written once. Neither says anything about output
 * format: the system prompt and the response-mode marker keep deciding the shape.
 */
const FINAL_TURN_INSTRUCTION =
  "this is your final turn and tool calls are disabled. Write the answer now " +
  "from the evidence already gathered. Do not ask for more data and do not promise follow-up work. " +
  "Thin evidence is not a reason to withhold a conclusion: give your best root-cause hypothesis, and if " +
  "you are producing an RCA set Confidence to Low and name the one check that would confirm it.";

/** The iteration ceiling: ten LLM calls spent. */
export const ITERATION_CEILING_NOTICE = `[ITERATION LIMIT REACHED — ${FINAL_TURN_INSTRUCTION}]`;

/**
 * The wall-clock ceiling. Named separately from the iteration one because the reason is a
 * different thing to be told: a model that is out of TIME has no cheaper question available,
 * while a model that is out of ITERATIONS might otherwise try to economise its next call.
 *
 * This ceiling used to have no notice at all — see the deadline branch in runInvestigation for
 * what it did instead, and why a slow backend is what turned it from theory into a live bug.
 */
export const TIME_BUDGET_NOTICE = `[TIME BUDGET REACHED — ${FINAL_TURN_INSTRUCTION}]`;

/**
 * An alert answered without reading anything.
 *
 * Measured in a 57-attempt run: A03 #2 and A04 #1 each produced a full RCA from one LLM call and
 * ZERO tool calls — fifteen thousand output tokens describing a cluster neither had looked at.
 * Both failed, and on the fact they could not have known: A04 never said "pull secret", because
 * nothing had told it there was one missing.
 *
 * Deliberately alert-mode only. In conversation mode a tool-free answer is often the correct one —
 * benchmark C07 declines an out-of-scope request with no tools three times out of three, and
 * nudging it would be telling it to go and do the thing it just correctly refused.
 *
 * This is the gap the other gates leave open by construction: `logGapAction` requires
 * `toolRounds > 0` before it will nudge, and the budget and deadline ceilings fire when the model
 * ran out of room rather than when it never asked for any.
 */
export const NO_EVIDENCE_NOTICE =
  "[EVIDENCE GAP — you answered an alert without calling a single tool. Everything above is the " +
  "alert payload and what you already believed; none of it was read from the cluster. An alert " +
  "names a symptom and a subject, and it is the starting point of an investigation rather than its " +
  "evidence. Go and look: the pod's state and events, the workload's spec, the logs of whatever is " +
  "failing. If what you find contradicts the answer you just wrote, the answer was wrong and the " +
  "evidence wins. Say what you actually read.]";

export const FABRICATED_EVIDENCE_NOTICE =
  "[FABRICATED EVIDENCE — the answer you just wrote quotes log lines or cluster output, and you " +
  "have not called a single tool this run. Nothing in it was read from the cluster; you wrote what " +
  "such output usually looks like. Delete it. Call the tools for what you were asked about, and " +
  "answer only from what comes back — quoting a timestamp, a pod name or a JSON field you did not " +
  "receive is the one thing that makes every other answer unusable. If the request is ambiguous " +
  "(a name matching many workloads), ask which one instead of picking one and inventing its logs.]";

/**
 * The other half, and the reason conversation mode cannot simply be added above.
 *
 * Benchmark C06, three attempts out of three, 2026-09-23: "check the logs for api in namespace
 * bench-c06" was answered in ONE LLM call with zero tool calls — and the answer carried a fenced
 * block of twelve invented log lines, with timestamps, JSON fields and a pod name, for a workload
 * `bench-api` that does not exist. Nothing in the loop objected: the fan-out guard never ran
 * (no tool call to cap), `needsEvidence` skips conversation mode, and `logGapAction` requires a
 * tool round before it will nudge.
 *
 * So the trigger is not the mode, it is the CLAIM: an answer that presents tool output it never
 * fetched. C07's correct tool-free refusal ("that's outside what I do") carries no such block and
 * stays untouched.
 *
 * Two shapes, because the same run produced both. Attempt 1 quoted twelve invented log lines in a
 * fence. Re-run after the first fix, the fence held only a LogQL query — and the answer still
 * asserted `bench-api`, a workload it had never looked up. With ZERO tool calls behind it, any
 * resource name the answer cites is by definition ungrounded: there is no tool result it could
 * have come from. `citedNames` is the same extractor `groundingGaps` uses, so the rule agrees with
 * the warning the run already posts instead of having its own idea of what a name is.
 *
 * C07's correct tool-free refusal cites nothing and quotes nothing, so it stays untouched.
 */
const FABRICATED_EVIDENCE =
  /```[\s\S]{0,4000}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|"level"\s*:|"msg"\s*:|\blevel=(?:error|warn|info)\b|\b(?:CrashLoopBackOff|OOMKilled|ImagePullBackOff)\b)/i;

export const fabricatesEvidence = (answer: string): boolean =>
  FABRICATED_EVIDENCE.test(answer) || citedNames(answer).length > 0;

/** Pure so it can be tested; the loop has no seam for the branch it guards. */
export function needsEvidence(s: {
  mode: RunMode;
  toolRounds: number;
  nudged: boolean;
  toolsDisabled: boolean;
  /** The answer just written, for the fabrication branch. Absent = the alert-mode rule only. */
  answer?: string;
}): boolean {
  if (s.nudged || s.toolsDisabled || s.toolRounds > 0) return false;
  return s.mode === "alert" || fabricatesEvidence(s.answer ?? "");
}

/**
 * A delegate's ceiling. Neither notice above can serve it: the budget one carries conversation
 * mode's format rule and tells the model to "offer to investigate", the ceiling one says nothing
 * about format at all and leaves the shape to the system prompt, which describes an RCA.
 *
 * The observed failure, 2026-08-31: `SUBAGENT_TOOL_ROUNDS` is 2, so a delegate that spends both
 * rounds lands on TOOL_BUDGET_NOTICE and does exactly what it says — one sub-investigation came
 * back with "Hey — here's what the data you provided shows, in plain Slack-friendly terms" and
 * markdown bullets, addressed to a human who was never going to read it, at 4796 chars against
 * its sibling's 2220. Its actual reader is the lead investigation, which wanted a verdict.
 *
 * DELEGATE_MARKER already says all of this, but it sits in `history[0]` while the notice is the
 * last thing in the context — the same losing position the mention marker was in, and the reason
 * that one is restated every turn.
 *
 * One notice for BOTH ceilings, because a delegate's reader never changes: there is no budget-vs-
 * iteration distinction to draw when neither outcome is ever addressed to a human.
 */
export const DELEGATE_BUDGET_NOTICE =
  "[BUDGET REACHED — this is your final turn and tool calls are disabled. Report now to the lead " +
  "investigation that asked for this, NOT to a human in Slack: open with SUPPORTED, CONTRADICTED " +
  "or UNPROVEN, then the evidence behind that verdict, each claim naming the tool it came from. " +
  "Do not use the RCA incident format, do not address a reader, and do not offer to investigate " +
  "further — there is no one to offer it to. Running out of budget is not a reason to withhold a " +
  "verdict: answer UNPROVEN and name what you could not check.]";

/**
 * Both ceilings end a run the same way — one more LLM call with no tools — but they are reached
 * by different paths and say different things. Returns the notice to inject, or null to keep going.
 *
 * The iteration clause is the one that matters. It fires at `maxIterations - 1` so the loop always
 * keeps a turn in hand to spend on an answer. Without it an alert investigation (which passes no
 * tool budget, so `maxToolRounds` is Infinity and the first clause can never fire) ran its tenth
 * round of tools, fell out of the `while`, and discarded every result it had gathered in favour of
 * an apology — in an on-call thread that had never been shown a single finding.
 *
 * The tool budget wins when both apply: conversation mode has a format rule the ceiling must not
 * overwrite. `depth` outranks both — see DELEGATE_BUDGET_NOTICE. Exported with its notices so the
 * loop's exit contract is testable without the class.
 */
export function forcedFinalAnswer(state: {
  toolRounds: number;
  maxToolRounds: number;
  iterations: number;
  maxIterations: number;
  /** 0 = the lead investigation, 1 = a delegate. Defaults to lead. */
  depth?: number;
  /**
   * True once the wall-clock deadline has passed. The THIRD ceiling, and the one that was
   * never wired: it returned an apology and discarded the evidence, which is exactly the
   * regression the iteration clause above was added to fix. It stayed invisible while every
   * backend answered in seconds; a transport that takes 20-100s per call reaches it on an
   * ordinary investigation.
   */
  outOfTime?: boolean;
}): string | null {
  const reached =
    state.toolRounds >= state.maxToolRounds ||
    state.iterations >= state.maxIterations - 1 ||
    !!state.outOfTime;
  if ((state.depth ?? 0) > 0) return reached ? DELEGATE_BUDGET_NOTICE : null;
  if (state.toolRounds >= state.maxToolRounds) return TOOL_BUDGET_NOTICE;
  if (state.iterations >= state.maxIterations - 1) return ITERATION_CEILING_NOTICE;
  // Last of the three: the other two are known before the clock is consulted, and a run that
  // trips a countable ceiling on the same turn is better told the countable reason.
  if (state.outOfTime) return TIME_BUDGET_NOTICE;
  return null;
}

/**
 * Whether a gate that asks for a FETCH (evidence, log gap, image gap) must stand down. Such a
 * nudge costs two calls — the fetch, then the answer — and `forcedFinalAnswer` is consulted only
 * after a tool round, so a nudge on the second-to-last call spent the answer turn on the fetch and
 * the loop fell out into the apology, discarding the answer the gate was holding. Measured
 * 2026-09-28 with SUBAGENT_MAX_ITERATIONS=3: five of five delegates.
 */
export const noToolRoundLeft = (s: { toolsDisabled: boolean; iterations: number; maxIterations: number }): boolean =>
  s.toolsDisabled || s.iterations >= s.maxIterations - 1;

// Per-thread skill sets live in memory, like ConversationMemory's rcaThreads. Bounded so a
// long-running pod cannot accumulate one entry per thread it has ever seen; eviction is
// insertion-order, and a thread that outlives its entry simply re-selects from its next message.
export const MAX_TRACKED_THREADS = 500;

/**
 * Identity of a tool call, for the per-investigation memo in executeToolCalls.
 *
 * Scalars are stringified and object keys sorted, so `{"start":1788487759}` and
 * `{"start":"1788487759"}` are ONE call. That is not a nicety — it is the exact pair a live
 * investigation produced: the first round came back `[]`, the model read the empty result as
 * a sign it had got the argument TYPE wrong, and re-sent all four tools with the numbers
 * quoted. The repeat cost a whole round, which spent the last of a 2-round budget and forced
 * the answer out early. Type-blind matching is what makes that a memo hit rather than a
 * second identical query.
 */
/**
 * Params that ask for MORE of the same thing rather than for a different thing.
 *
 * Live 2026-09-22, one thread: `k8s_get_pod_logs` on the same pod four rounds running —
 * `tail_lines: 200`, then `10`, then `200`, then `200` again. Every one of them a fresh call,
 * because the key includes the number, and every one of them ~90 seconds of a slow backend for
 * output the run already had.
 *
 * So they come out of the key, and the memo carries the window it fetched instead: a narrower
 * request is served from a wider result (the tail of 200 lines contains the tail of 10), a wider
 * one re-runs. Keeping them IN the key is what made four rounds of the same read possible;
 * ignoring them without checking coverage would answer "the last 200 lines" with ten of them.
 */
const WINDOW_PARAMS = ["tail_lines", "since_seconds", "limit"] as const;

/** The size of what was asked for, in WINDOW_PARAMS order. Absent = the server's default, 0. */
export function windowOf(input: unknown): number[] {
  const o = (input ?? {}) as Record<string, unknown>;
  return WINDOW_PARAMS.map((k) => (typeof o[k] === "number" ? (o[k] as number) : Number(o[k]) || 0));
}

/** Does a memoised result already contain what this call is asking for? */
export const memoCovers = (cached: number[], asked: number[]): boolean =>
  asked.every((v, i) => (cached[i] ?? 0) >= v);

export function toolCallKey(name: string | undefined, input: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)])
      );
    }
    return String(v);
  };
  const rest = { ...((input ?? {}) as Record<string, unknown>) };
  for (const k of WINDOW_PARAMS) delete rest[k];
  return `${name ?? ""}\u0000${JSON.stringify(norm(rest))}`;
}

/**
 * The placeholders the prompt's example queries use — `{namespace="X", app="Y"}` — sent as if
 * they were values.
 *
 * Live 2026-09-22 on the heavy route (gpt-5-nano), two CPU-throttling alerts in `sample-apps`:
 * every Prometheus, Loki, k8s and tracing call went to namespace `X` / service `Y`. All came back
 * empty, the model read that as "no pods found in namespace sample-apps", and the second run
 * posted an approval card to restart `sample-apps/storefront` on it. The first run's RCA had
 * already reached incident memory, so the second opened with "I know X" — recall taught it the
 * placeholder was the namespace.
 *
 * Exact and safe to refuse: Kubernetes names are lowercase DNS-1123, so a bare `X` or `Y` can
 * never be one, and no label value in this cluster is a single capital letter. Returns the
 * offending fragment, or null.
 */
export function placeholderIn(input: unknown): string | null {
  const walk = (v: unknown): string | null => {
    if (typeof v === "string") {
      if (/^[XY]$/.test(v)) return v;
      return v.match(/[=~]\s*"[XY]"/)?.[0] ?? null;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) {
        const hit = walk(x);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(input);
}

export const PLACEHOLDER_REFUSAL = (hit: string, namespace?: string) =>
  `Error: \`${hit}\` is a placeholder copied from the prompt's example queries, not a value — ` +
  `nothing in this cluster is called X or Y, so the call would return empty and prove nothing. ` +
  (namespace
    ? `Re-issue it with namespace \`${namespace}\`, which is what this alert's labels say. Do NOT ask ` +
      `the human which namespace to use — it is already in the alert in front of you.`
    : `Re-issue it with the real namespace / workload / service named in the alert or the user's message. ` +
      `Do NOT ask the human to supply it — read it from the message you were given.`) +
  ` A prior incident that mentions namespace "X" is a record of this same mistake, not evidence of a namespace.`;

// Loud on purpose. Handing back the same payload silently is what let the model try a third
// spelling; it has to be told the result is a property of the data, not of how it asked.
export const REPEAT_NOTICE =
  "[repeat call] You already ran this exact tool with these exact arguments in this " +
  "investigation. The result below is that same result — calling it again, or with the " +
  "arguments spelled differently, returns this. If it is empty, the data does not exist: " +
  "query something else or answer with what you have.\n\n";

/**
 * The last four exist for sub-agent delegation: a delegate is the same loop run with a smaller
 * budget, a borrowed deadline, and no delegate tool of its own. They are options rather than a
 * second loop because the guards that matter — the [WRITE] filter, the namespace scope lock, the
 * log fan-out cap, the forced final answer — live in that loop, and a copy of it is a copy of
 * them that drifts.
 */
/**
 * Fires one progress report for a tool round.
 *
 * A four-line function with its own name because three things in it are worth pinning and
 * none of them is reachable from a test otherwise: the round number is off by one from
 * `toolRounds` (which is incremented after the tools run, not before), the names must be
 * the ones that will ACTUALLY run rather than the ones the model asked for — the scope
 * lock and the fan-out guard have already removed some — and a callback that throws must
 * be swallowed. The last one is the reason this is not inline: a Slack outage must not end
 * an investigation that is already three rounds deep in evidence.
 */
export function reportProgress(
  onProgress: ((round: number, tools: string[]) => void) | undefined,
  toolRounds: number,
  running: Array<{ name?: string }>,
  onError: (err: unknown) => void
): void {
  if (!onProgress) return;
  const names = [...new Set(running.map((t) => t.name).filter(Boolean))] as string[];
  try {
    onProgress(toolRounds + 1, names);
  } catch (err) {
    onError(err);
  }
}

/**
 * What kind of run this is. Three things read it and none of them can work it out alone:
 *
 * - `rca-format` loads only outside `conversation`. It used to be `when: always`, so the RCA
 *   template rode along on every casual mention and argued with the conversation-mode marker in
 *   the very same message. The small model sided with the skill.
 * - the log-gap gate fires only on `alert`. Its own notice says "the playbook for this alert";
 *   on a mention there is no alert and no affected pod, so demanding container logs for
 *   "any anomalies in the last hour?" is a demand nothing can satisfy.
 * - a delegate is `alert` because it is a slice of one.
 *
 * Not derivable from the other options: `maxToolRounds` is `Infinity` for BOTH the alert path
 * and an explicit investigation request, and `trigger` is set by the alert path only as an
 * accident of skill selection. Stating it is what stops the next reader guessing.
 */
export const RUN_MODES = ["alert", "investigation", "conversation"] as const;

export type RunMode = (typeof RUN_MODES)[number];

/** The tag `runInvestigation` puts at the head of the skill trigger. See skills/index MODE_TAG. */
export const modeTag = (mode: RunMode): string => `[mode:${mode}]`;

/** A skill that keys on the run mode describes the shape of the answer, not the fault. */
export const keysOnMode = (s: Skill): boolean =>
  s.when !== "always" && RUN_MODES.some((m) => [...modeTag(m).matchAll(s.when as RegExp)].length > 0);

/**
 * The text a tool round actually produced — tool_result payloads plus any synthesized notice.
 * Returned per block rather than joined: `select` truncates its trigger, and one long result
 * would otherwise push a later result's decisive line ("Failed to pull image") out of the
 * window entirely.
 */
export function evidenceTexts(blocks: readonly ContentBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const text =
      b.type === "tool_result" && typeof b.content === "string"
        ? b.content
        : b.type === "text"
          ? (b.text ?? "")
          : "";
    // The evidence stamp is bookkeeping, not evidence — a playbook must never be selected by it.
    if (text.trim() && !text.startsWith(EVIDENCE_STAMP_PREFIX)) out.push(text);
  }
  return out;
}

/**
 * Stamps a tool round with the wall-clock time its results were read, appended to the same user
 * message the results ride in.
 *
 * A `tool_result` in the history carries no time of its own, and neither does the message around
 * it, so by turn 11 of a conversation the model is looking at a `k8s_cluster_health` snapshot
 * from 40 minutes earlier that is indistinguishable from one taken this second. It answers from
 * it. Measured on thread 1789488072 (2026-09-15): "cluster resource saat ini gimana?" at 16:44
 * was answered with `59 pods in 14 namespaces` — the output of a health scan run at 16:14 — with
 * zero tool calls that turn, and the grounding check flagged a namespace no tool result in the
 * thread had ever returned.
 *
 * In the history rather than in a side table so it survives a pod restart: the conversation comes
 * back from Redis and the stamp comes back with it.
 */
export const EVIDENCE_STAMP_PREFIX = "[EVIDENCE READ AT]";

export const evidenceStamp = (now: number = Date.now()): string =>
  `${EVIDENCE_STAMP_PREFIX} ${new Date(now).toISOString()} (unix ${Math.floor(now / 1000)})`;

/** Under this, the evidence is effectively current and the notice is noise. */
export const STALE_EVIDENCE_MINUTES = 2;

const STAMP_RE = /\[EVIDENCE READ AT\][^(\n]*\(unix (\d+)\)/g;

/**
 * Warns the NEXT turn that everything it can see was read in an earlier one. Empty when the
 * thread has no stamped evidence yet, or when the freshest is younger than STALE_EVIDENCE_MINUTES.
 *
 * Reads the newest stamp, not the oldest: it is the most generous number available, and the
 * claim has to stay true — anything older than the freshest result is older still.
 */
export function staleEvidenceNotice(history: readonly Message[], now: number = Date.now()): string {
  let newest = 0;
  for (const m of history) {
    const texts =
      typeof m.content === "string"
        ? [m.content]
        : m.content.map((b) => (b.type === "text" ? (b.text ?? "") : ""));
    for (const t of texts) {
      for (const match of t.matchAll(STAMP_RE)) {
        const unix = Number(match[1]);
        if (unix > newest) newest = unix;
      }
    }
  }
  if (newest === 0) return "";
  const minutes = Math.floor((now - newest * 1000) / 60000);
  if (minutes < STALE_EVIDENCE_MINUTES) return "";
  return (
    `[STALE EVIDENCE — the freshest tool result already in this conversation was read ${minutes} ` +
    `minutes ago, at ${new Date(newest * 1000).toISOString()}; everything else is older. Those ` +
    `results describe the cluster AS IT WAS THEN. If this question is about the state right now ` +
    `("saat ini", "sekarang", "now", "still", "already"), call the tools again and answer from ` +
    `the new result — do not restate counts, pod names or statuses from the old ones. A re-read ` +
    `costs one round; a stale "everything is healthy" costs an incident.]`
  );
}
