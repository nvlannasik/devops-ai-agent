/**
 * An RCA that stops early, and the one more turn it takes to finish it.
 *
 * Measured live on 2026-09-24, five alerts firing at once: three of six answers were partial. One
 * began at `*📍 Root Cause*` with no severity line at all, which is why the card above it read
 * `⚪ Unknown Severity Incident` — the renderer's fallback working correctly on an input that was
 * incomplete. Postgres agreed from the other side: incidents 160, 162 and 163 all stored
 * `confidence = unknown`, because there was no Confidence section to parse.
 *
 * Three explanations were tested and all three failed. Not truncation: every final answer ended
 * `stop=end_turn`, never `max_tokens`. Not the iteration ceiling: one partial answer took three
 * LLM calls and hit nothing. Not playbook crowding: a complete answer and a partial one loaded the
 * identical set, `[pod-not-ready, rca-format]`. The model simply stopped early, having spent its
 * output budget reasoning — the partial answers' token counts are the LARGER ones.
 *
 * So it is the shape this repo keeps finding: the template says produce all of it, the small heavy
 * model does not, and the answer is a gate rather than another paragraph of prompt.
 *
 * REQUIRED is short on purpose, and every entry earns its place by having a consumer that breaks
 * without it. Taste is not a reason to spend an LLM call.
 */

import { SEVERITY_PATTERN, extractSection } from "../../utils/slack/blocks.js";
import { parseConfidence } from "../confidence/index.js";

const REQUIRED: Array<{ label: string; consumer: string; present: (rca: string) => boolean }> = [
  {
    label: "Severity",
    consumer: "the card header and `incidents.severity`",
    // A line, not a section — the one label in the template whose bold closes mid-line.
    present: (rca) => SEVERITY_PATTERN.test(rca),
  },
  {
    label: "Recommended Actions",
    consumer: "the remediation step, which reads the Immediate line and nothing else",
    present: (rca) => extractSection(rca, "Recommended Actions") !== "",
  },
  {
    label: "Confidence",
    consumer: "the on-call notification on a Low rating, and `incidents.confidence`",
    // Severity's twin, and for the same reason: its bold closes mid-line, so `extractSection`
    // — which wants a newline after the heading — returns "" for a Confidence line that is
    // perfectly well formed. `parseConfidence` is the reader that decides the field downstream,
    // so asking it is both correct and the same verdict Postgres stored as `unknown`.
    present: (rca) => parseConfidence(rca) !== "unknown",
  },
];

/** The required sections this answer does not have, in template order. */
export const rcaGaps = (rca: string): string[] => REQUIRED.filter((s) => !s.present(rca)).map((s) => s.label);

/**
 * Names what is missing and what each missing piece was for, then asks for the WHOLE answer back.
 *
 * Not "append the missing sections": the reply REPLACES the held answer, so a model that returns
 * only the two it forgot would leave the RCA shorter than it started. The notice says so outright
 * for that reason.
 */
export function rcaGapNotice(missing: string[]): string {
  const named = REQUIRED.filter((s) => missing.includes(s.label))
    .map((s) => `${s.label} — ${s.consumer}`)
    .join("; ");
  return (
    `[INCOMPLETE RCA — your answer is missing: ${named}. The investigation is finished and this is ` +
    `not a request for more tool calls: everything needed is already in this thread. Post the ` +
    `COMPLETE RCA again, every section of the template in order, with the missing ones filled from ` +
    `what you already found. Send the whole answer, not only the missing parts — this reply ` +
    `replaces the previous one rather than being added to it. Do not shorten the sections you ` +
    `already wrote, and do not invent a finding to fill a section: Severity is your own judgement ` +
    `of the impact you measured, and Confidence is how well the evidence you cited supports the ` +
    `conclusion.]`
  );
}
