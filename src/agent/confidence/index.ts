export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

// matches the RCA output format: "*📈 Confidence:* `High`" or "Confidence Level: High"
// anchored to the label so it won't match mid-sentence phrases like "does not indicate high confidence"
const CONFIDENCE_PATTERN = /(?:📈\s*)?confidence(?:\s+level)?[^a-z\n]{0,10}[:`]\s*[`*]?\s*\[?(high|medium|low)\]?\b/i;

export function parseConfidence(rcaText: string): ConfidenceLevel {
  const match = rcaText.match(CONFIDENCE_PATTERN);
  if (!match) return "unknown";
  return match[1].toLowerCase() as ConfidenceLevel;
}
