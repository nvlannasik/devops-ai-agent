export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

export function parseConfidence(rcaText: string): ConfidenceLevel {
  const match = rcaText.match(/confidence level[:\s*]+([^\n*]+)/i);
  if (!match) return "unknown";
  const value = match[1].toLowerCase().trim();
  if (value.includes("high")) return "high";
  if (value.includes("medium")) return "medium";
  if (value.includes("low")) return "low";
  return "unknown";
}
