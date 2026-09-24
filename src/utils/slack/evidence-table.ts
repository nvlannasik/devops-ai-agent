/**
 * The Evidence section as a Block Kit `table`, which Slack renders with real columns.
 *
 * Verified before it was built, by posting one to the alert channel on 2026-09-25: the API accepts
 * it (`ok: true`, not `invalid_blocks`) and the client draws a bordered two-column table with
 * inline code intact inside the cells. That last part is why the cells are `rich_text` and not
 * `raw_text`: a resource name has to stay in code style, and not for looks — `groundingGaps`
 * harvests its candidate names from exactly those backticks, and the format rules mandate them.
 *
 * Returns null whenever the section is not clearly a list of findings, and the caller keeps the
 * bullet list it has always rendered. That direction is deliberate: `buildRcaBlocks` failing is
 * not a cosmetic problem — a card Slack rejects takes the whole RCA with it, which cost one
 * investigation on 2026-09-23 before `section()` learned to split.
 */

import type { KnownBlock } from "@slack/types";

/** A cell's contents: our own mrkdwn subset, as rich_text spans. */
type Span = { type: "text"; text: string; style?: { code?: true; bold?: true; italic?: true } };

/**
 * `code` wins over the others and is consumed first — a backticked resource name may contain
 * underscores (`k8s_describe_pod`, `container_memory_working_set_bytes`), and letting the italic
 * rule run inside one would cut the name in half.
 */
export function toSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const part of text.split(/(`[^`]+`)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push({ type: "text", text: part.slice(1, -1), style: { code: true } });
      continue;
    }
    // The italic run may CONTAIN underscores, and refusing them is what broke the first version:
    // `_k8s_list_pods_` is a snake_case tool name in italics, and a non-greedy `[^_]+` closed on
    // the underscore after `k8s`, leaving three spans and a mangled name. So the close has to be
    // an underscore not followed by a word character, and the open one not preceded by one —
    // which is also what keeps `shop_api_v2` in running prose from becoming italics.
    for (const bit of part.split(/(\*[^*\n]+\*|(?<!\w)_[^\n]+?_(?!\w))/g)) {
      if (!bit) continue;
      if (bit.length > 2 && bit.startsWith("*") && bit.endsWith("*")) {
        out.push({ type: "text", text: bit.slice(1, -1), style: { bold: true } });
      } else if (bit.length > 2 && bit.startsWith("_") && bit.endsWith("_")) {
        out.push({ type: "text", text: bit.slice(1, -1), style: { italic: true } });
      } else {
        out.push({ type: "text", text: bit });
      }
    }
  }
  return out.length > 0 ? out : [{ type: "text", text }];
}

/**
 * The source suffix the template asks for: ` — _tool_name_ \`namespace/resource\``.
 *
 * Anchored on the tool name CONTAINING an underscore, which every tool on this server does
 * (`k8s_*`, `prometheus_query`, `loki_query_range`). A finding routinely ends in a backticked
 * value of its own, so splitting on the last dash would put half the sentence in the Source
 * column; requiring the snake_case shape is what tells the two apart.
 */
const SOURCE = /\s+[—–]\s+(_?[a-z][a-z0-9]*(?:_[a-z0-9]+)+_?)((?:\s+`[^`]+`)*)\s*$/i;

const BULLET = /^[ \t]*(?:[•*\-–]|\d+\.)[ \t]*/;

const cell = (text: string): KnownBlock =>
  ({ type: "rich_text", elements: [{ type: "rich_text_section", elements: toSpans(text) }] }) as KnownBlock;

/** Rows as (finding, source) pairs; a line with no recognisable source keeps an empty Source. */
export function evidenceRows(evidence: string): Array<[string, string]> {
  return evidence
    .split("\n")
    .map((l) => l.replace(BULLET, "").trim())
    .filter((l) => l !== "")
    .map((line): [string, string] => {
      const m = line.match(SOURCE);
      return m ? [line.slice(0, m.index).trim(), `${m[1]}${m[2]}`.trim()] : [line, ""];
    });
}

/** Slack's own ceilings, and one of ours. */
const MAX_ROWS = 50; // Slack allows 100; fifty findings is a report, not a card
const MAX_CELL_CHARS = 1500;

export function evidenceTable(evidence: string): KnownBlock | null {
  const rows = evidenceRows(evidence);
  // One row is a sentence, and a one-row table reads worse than the bullet it replaced.
  if (rows.length < 2 || rows.length > MAX_ROWS) return null;
  if (rows.some(([f, s]) => f.length > MAX_CELL_CHARS || s.length > MAX_CELL_CHARS)) return null;
  // Every Source empty means the shape is not what this reads — a prose paragraph, or a template
  // the model rewrote. The bullet list renders that honestly; a table would invent a column and
  // then leave it blank down the page.
  if (rows.every(([, s]) => s === "")) return null;

  return {
    type: "table",
    // Wrapped, both columns: a finding is a sentence and the default is no wrapping at all, which
    // on a phone turns the section into a sideways scroll.
    column_settings: [{ is_wrapped: true }, { is_wrapped: true }],
    rows: [
      [
        { type: "raw_text", text: "Finding" },
        { type: "raw_text", text: "Source" },
      ],
      ...rows.map(([finding, source]) => [cell(finding), cell(source)]),
    ],
  } as KnownBlock;
}
