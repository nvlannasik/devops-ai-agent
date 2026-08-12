export const MAX_TOOL_RESULT_CHARS = 8000; // ~2.7k tokens per tool result

const MIN_RUN = 3;
const TRUNCATION_NOTICE = (remaining: number) => `\n...[truncated ${remaining} chars]...\n`;

// What makes two log lines "the same line": everything but the clock and the counters.
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const DIGIT_RUN = /\d{2,}/g;

const normalize = (line: string): string => line.replace(TIMESTAMP, "<ts>").replace(DIGIT_RUN, "<n>");

// Only CONSECUTIVE runs. A global dedupe would merge two phases of an incident: the same error
// at 14:02 and again at 14:31, with a recovery in between, is the signal.
function collapseRuns(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = normalize(lines[i]!);
    let j = i + 1;
    while (j < lines.length && normalize(lines[j]!) === key) j++;
    out.push(lines[i]!);
    const run = j - i;
    if (run >= MIN_RUN) {
      out.push(`... ×${run - 1} more like this`);
    } else {
      for (let k = i + 1; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join("\n");
}

/**
 * Compacts one tool result. Runs at INGEST, so the compacted form is what reaches Redis and the
 * raw output is not recoverable afterwards — the deliberate trade is not storing full raw
 * results under a 24h TTL for every investigation.
 */
export function compactToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;

  const collapsed = collapseRuns(content);
  if (collapsed.length <= MAX_TOOL_RESULT_CHARS) return collapsed;

  // Head AND tail: logs are chronological, so the most recent lines live at the END and
  // head-only truncation drops exactly what "show me the logs" was asking for.
  const half = MAX_TOOL_RESULT_CHARS / 2;
  const remaining = collapsed.length - MAX_TOOL_RESULT_CHARS;
  return collapsed.slice(0, half) + TRUNCATION_NOTICE(remaining) + collapsed.slice(-half);
}
