export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

// matches the RCA output format: "*📈 Confidence:* `High`" or "Confidence Level: High"
// anchored to the label so it won't match mid-sentence phrases like "does not indicate high confidence"
const CONFIDENCE_PATTERN = /(?:📈\s*)?confidence(?:\s+level)?[^a-z\n]{0,10}[:`]\s*[`*]?\s*\[?(high|medium|low)\]?\b/i;

export function parseConfidence(rcaText: string): ConfidenceLevel {
  const match = rcaText.match(CONFIDENCE_PATTERN);
  if (!match) return "unknown";
  return match[1].toLowerCase() as ConfidenceLevel;
}

/**
 * "The logs were not available" and "Confidence: High" cannot both be true in the same answer.
 *
 * LOG_GAP_NOTICE already tells the model to lower it, and bench case C03 — whose whole premise is
 * a container that logs nothing — still rated itself High in two of its last six attempts while
 * otherwise answering correctly. Same shape as every other gate in this repo: the prompt rule
 * stays, and the contradiction is settled in code because the prompt rule does not hold on the
 * small heavy model.
 *
 * Both halves are required, and each excludes a different false positive:
 *  - the ANSWER states the log source yielded nothing. Not that the logs were CLEAN: "no error
 *    logs were found" on a healthy workload is a complete answer with earned confidence, and the
 *    notice says so in as many words.
 *  - no log tool returned lines this run. An answer that misdescribes logs it DID read is a
 *    different bug, and capping its confidence would paper over it.
 *
 * Medium, not Low: Low pages the on-call (`notifyIfLowConfidence`), and a missing log is not by
 * itself a reason to wake someone.
 */
const LOG = String.raw`(?:container |pod |application |app |worker )?logs?(?:\s+(?:lines?|entries|output|data))?`;

const EVIDENCE_GAP: RegExp[] = [
  // "no logs", "no log lines", "no container log output" — but NOT "no error logs", which is a
  // statement about what the logs contain rather than about whether they could be read.
  new RegExp(String.raw`\b(?:no|zero)\s+${LOG}\b`, "i"),
  new RegExp(String.raw`\b${LOG}\b[^.\n]{0,40}\b(?:unavailable|not available|inaccessible|empty|missing|absent|not retained)\b`, "i"),
  new RegExp(String.raw`\b${LOG}\b[^.\n]{0,40}\breturned\s+(?:no|nothing|zero)\b`, "i"),
  new RegExp(String.raw`\b(?:could not|couldn'?t|unable to|failed to)\s+(?:\w+\s+){0,2}(?:retrieve|fetch|read|obtain|access|collect)\b[^.\n]{0,30}\b${LOG}\b`, "i"),
  new RegExp(String.raw`\b(?:produced|emitted|wrote|generated)\s+(?:no|zero)\s+(?:${LOG}|output)\b`, "i"),
  new RegExp(String.raw`\btidak ada\s+(?:\w+\s+){0,2}log\b|\blog[^.\n]{0,30}\b(?:tidak tersedia|kosong|nihil)\b`, "i"),
];

/**
 * The level word alone is swapped, so whatever markup the model wrapped it in survives — the
 * label is the one in the RCA template whose bold closes mid-line, and it drifts (see
 * SEVERITY_PATTERN). The rest of the line goes with it: the reasoning that argued for High does
 * not support Medium.
 */
const HIGH_LINE = /^(.*?confidence(?:\s+level)?[^a-z\n]{0,10}[:`]\s*[`*]?\s*\[?)high(\]?[`*]?)[^\n]*$/im;

const CAPPED_REASON = "the answer states the logs behind it were not available";

export function capConfidence(answer: string, sawLogLines: boolean): { text: string; capped: boolean } {
  if (sawLogLines) return { text: answer, capped: false };
  if (parseConfidence(answer) !== "high") return { text: answer, capped: false };
  if (!EVIDENCE_GAP.some((re) => re.test(answer))) return { text: answer, capped: false };
  return { text: answer.replace(HIGH_LINE, `$1Medium$2 — ${CAPPED_REASON}`), capped: true };
}
