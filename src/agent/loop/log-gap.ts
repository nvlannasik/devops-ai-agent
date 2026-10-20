import { type Skill } from "../skills/index.js";
import { isRcaResponse } from "../../utils/slack/blocks.js";
import type { RunMode } from "./control.js";

/**
 * The tools whose RESULT is log lines, and the notice for an investigation that answered without
 * any of them.
 *
 * This is a prompt rule that did not hold, moved into code — the same move `worthProposing` and
 * the fan-out cap already made. `prompts/skills/crashloopbackoff.md` step 2 says to call
 * `k8s_get_pod_logs` with `previous: true`, and the playbook WAS selected: benchmark case B04
 * loaded it, called `k8s_describe_pod`, and then wrote *"Immediate: Retrieve previous-container
 * logs for all 8 pods"* into its own Recommended Actions — recommending to a human the tool call
 * it was holding. The crash message it never read said `FATAL: DATABASE_URL is not set`. Three
 * attempts out of three.
 *
 * A13 is the same gap one level in, and it is why "did we CALL a log tool" is not the test:
 * `loki_query_range` was called, with a `level="error"` filter the workload's output does not
 * carry, and an empty result was reported as "no errors in the window" for a pod printing
 * `cannot list resource "pods"` every fifteen seconds. So the test is whether any log tool
 * RETURNED anything.
 *
 * Only fires when a selected playbook names a log tool, which is what keeps it off the cases
 * that have no logs to read by construction — a Pending pod never started a container.
 */
export const LOG_TOOLS: ReadonlySet<string> = new Set(["k8s_get_pod_logs", "loki_query", "loki_query_range"]);

/**
 * ponytail: a length threshold, not a parse. An empty Loki response used to be a JSON envelope
 * around an empty array, ~35 characters (measured); a `previous: true` log fetch of a dead container
 * is hundreds. Parsing each tool's own empty shape would mean tracking three response formats from
 * another repo.
 */
const LOG_RESULT_MIN_CHARS = 200;

// The one empty shape that IS tracked, because it defeats the threshold above. Since devops-mcp-server
// explains an empty Loki answer — pipeline dead, namespace silent, or filter matched nothing — that
// answer runs to 350-500 characters while holding no line at all. By length alone it would count as
// "saw log lines", and the cost is no longer one extra LLM call: the log-gap gate would stay silent
// and capConfidence would stop capping, on exactly the investigations where the logs were missing.
// The marker is a cross-repo contract (explainEmptyLogs in devops-mcp-server/src/utils/loki); a
// regex rather than JSON.parse, because the injection frame can append text after the JSON.
const NO_LOG_LINES = /"noLogLines"\s*:\s*true/;

// An error is not a log, and both ways a failed call reaches here open with a marker: the MCP
// server's `Error: …` and the SDK's `MCP error -32602: …` for an input the schema refused. Either
// clears LOG_RESULT_MIN_CHARS easily — a zod rejection of loki `start`/`end` sent as numbers is 435
// chars (bench C03, 2026-09-29) — and counted as "saw log lines": the log-gap gate went silent and
// capConfidence passed a High the answer itself said the logs could not support.
const TOOL_ERROR = /^\s*(?:Error:|MCP error\b)/;

// A memoised result arrives behind REPEAT_NOTICE, and the notice is OUR sentence, ~300 chars of
// it. Measured with it, a 126-char empty pod-log result crossed the threshold on its repeat and
// flipped sawLogLines after the log-gap nudge (bench C03, 2026-09-29) — which is also what the
// unexplained "cap still declined" of 2026-09-24 was. The result is measured, never the notice.
const REPEAT_PREFIX = /^\[repeat call\][^\n]*\n\n/;

/** Did a log tool's result actually carry log lines? Exported for the test. */
export const returnedLogLines = (content: string): boolean => {
  const result = content.replace(REPEAT_PREFIX, "");
  return result.length >= LOG_RESULT_MIN_CHARS && !NO_LOG_LINES.test(result) && !TOOL_ERROR.test(result);
};

/**
 * Did any log call in a delegate's tool memo return lines? How a delegate's evidence reaches its
 * parent's log-gap gate: the parent only ever saw its own calls, so on 2026-09-29 (thread
 * 1790690405.435999) a delegate had read 273K chars of Loki and quoted the 502s, and the parent
 * was still nudged for "no log lines" — the round that cost it its RCA (see nudgeLostRca). The
 * memo holds raw results and successes only, keyed `${name}\u0000…` by toolCallKey.
 */
export async function memoSawLogLines(memo: ReadonlyMap<string, { result: Promise<string> }> | undefined): Promise<boolean> {
  for (const [key, { result }] of memo ?? []) {
    if (LOG_TOOLS.has(key.split("\u0000")[0]) && returnedLogLines(await result.catch(() => ""))) return true;
  }
  return false;
}

/**
 * Did the round a nudge bought turn a finished RCA into something that is not one?
 *
 * The retry REPLACES the answer it interrupted. Live 2026-09-29 (thread 1790690405.435999): the
 * log-gap round fetched the logs and then answered "Here are the last 10 log lines from the
 * affected pod, as requested" — it read the notice as the request — and a complete RCA reached
 * Slack as a chat message with no card. The restore rule only catches a round that fetched
 * nothing; this one compares the answers. Not for the zero-tool-call nudge (heldBy null): the
 * answer that one interrupted had no evidence behind it, so it is not worth keeping.
 */
export const nudgeLostRca = (s: { mode: string; heldBy: "tools" | "rca" | null; before: string; after: string }): boolean =>
  s.mode === "alert" && s.heldBy !== null && isRcaResponse(s.before) && !isRcaResponse(s.after);

export const LOG_GAP_NOTICE =
  "[EVIDENCE GAP — the playbook for this alert reads the container's own logs, and no log query has " +
  "returned any lines yet. Before you answer, call `k8s_get_pod_logs` (tail_lines: 200) on an affected " +
  "pod. Pick the instance from the pod's state, not from habit: if the container has RESTARTED or is " +
  "in CrashLoopBackOff, the crash message is in the dead instance, so pass `previous: true`; if the " +
  "pod is Running and has not restarted, there IS no previous instance — fetch the current logs. If a " +
  "`previous: true` call comes back empty or not-found, that is the answer to which instance to read, " +
  "so retry without it rather than reporting the logs as unavailable. If a log query came back empty, " +
  "that is a fact about the QUERY and not about the workload: drop the level/severity filter and widen " +
  "the selector, or read the pod logs directly instead of Loki. Only if the logs are genuinely " +
  "unavailable after that, say so explicitly in the answer and state what it leaves unconfirmed — and " +
  "lower the Confidence only if your conclusion actually depends on them. Finding a healthy workload " +
  "and quiet logs is a complete answer, not a thin one. Do not recommend that a human run a log query " +
  "you can run yourself. This notice is not a request to show logs: once you have read them, answer " +
  "with your complete answer again, in the same format, with the log lines as its evidence.]";

/** Does any loaded playbook name a log tool? Read from the body, so a new playbook gets this free. */
export const demandsLogs = (skills: readonly Skill[]): boolean =>
  skills.some((s) => !isShapeSkill(s) && [...LOG_TOOLS].some((t) => s.body.includes(t)));

/**
 * A skill triggered by the MODE tag (`rca-format`, `when: mode:(alert|investigation)`) describes the
 * SHAPE of an answer, never what evidence a fault needs — so a log tool named inside it, even as an
 * example, must not arm the log-gap gate.
 *
 * It did, for a day and a half. Commit 8d48af8 (2026-09-25) added `_loki_query_range_` to
 * rca-format's citation rule as an example of naming the tool you called. rca-format rides EVERY
 * alert, and demandsLogs is a substring test over playbook bodies, so from then on every alert
 * "demanded logs" — including a Pending pod and an ImagePullBackOff, whose containers never started
 * and CANNOT have logs. Measured in the 2026-09-25 full run: the model wrote a complete RCA, was
 * nudged to fetch logs, fetched nothing (there was nothing), and its short reply to the nudge
 * ("I pulled the logs for the affected pod as requested…") replaced the RCA — because the extra
 * round had run tools, the restore rule did not apply. Six attempts across A04, A05, A06 and A09
 * ended on such a stub; A05 and A09 lost their proposal to it, since the proposal step reads only
 * the final text. Nothing logged an error: a prompt edit had silently moved a code gate.
 */
export const isShapeSkill = (s: Skill): boolean => s.when !== "always" && s.when.source.startsWith("mode:");

export interface LogGapState {
  mode: RunMode;
  /** demandsLogs(skills) for the playbooks this run is carrying. */
  demandsLogs: boolean;
  sawLogLines: boolean;
  nudged: boolean;
  toolsDisabled: boolean;
  toolRounds: number;
  /** toolRounds at the moment the nudge fired; -1 while it has not. */
  toolRoundsAtNudge: number;
  /**
   * WHICH gate is holding an answer from before its nudge — not merely that one is.
   *
   * It was a boolean, and that is how a correct answer came to be thrown away. `"tools"` is a
   * nudge that asked the model to go and FETCH something (the log gap, the image gap), so an
   * extra round with no tool calls means it learned nothing and the earlier answer stands.
   * `"rca"` is the completeness gate, whose request is the opposite — the investigation is over,
   * rewrite what you wrote — so its successful round has no tool calls by design and this test
   * must not see it. A boolean could not tell the two apart; the type now makes the caller say.
   */
  heldBy: "tools" | "rca" | null;
}

/**
 * What to do with an answer the model just finished writing, from the log-gap gate's point of view.
 *
 * `restore` is the half that was missing and it is the expensive one. The nudge appends a notice
 * and loops, so whatever the model says next REPLACES the answer it interrupted — and on
 * 2026-09-15 a correct "no anomalies; 59 pods across 14 namespaces healthy" was replaced twice in
 * one thread by the scope-refusal boilerplate ("That's outside what I do — I'm a DevOps agent for
 * this cluster"). The first answer was complete, was never posted, and nothing in the log said it
 * had been thrown away. So: if the extra round ran no tools, it learned nothing, and the answer
 * it produced cannot be an improvement on the one it displaced.
 *
 * `nudge` is alert-mode only. `demandsLogs` reads the playbooks the THREAD is carrying, which on
 * a mention is whatever earlier turns accumulated; "apakah ada anomali di cluster 1 jam
 * kebelakang ini?" has no affected pod whose container logs could answer it.
 */
export function logGapAction(s: LogGapState): "answer" | "nudge" | "restore" {
  // `holdingAnswer` means a TOOL-SEEKING gate is holding one. The test below — the extra round
  // ran no tools, so it learned nothing — is true only of a nudge that asked for a fetch, and the
  // RCA-completeness gate asks for the opposite: the investigation is over and the answer has to
  // be rewritten. A successful round of that gate therefore looks exactly like a failed one here.
  //
  // Measured 2026-09-25, twice in one burst: the completion round returned a 5656-character RCA
  // carrying all eight sections, and this line threw it away for the 4650-character four-section
  // answer it had replaced — "keeping the pre-nudge answer (4650 chars) over the retry's 5656".
  // The caller no longer reports that gate's hold here; see `heldBy` in the loop.
  if (s.heldBy === "tools" && s.toolRounds === s.toolRoundsAtNudge) return "restore";
  if (
    s.mode === "alert" &&
    s.demandsLogs &&
    !s.sawLogLines &&
    !s.nudged &&
    !s.toolsDisabled &&
    s.toolRounds > 0
  ) {
    return "nudge";
  }
  return "answer";
}
