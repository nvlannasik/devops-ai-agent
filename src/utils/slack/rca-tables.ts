/**
 * The RCA sections that are really lists, as Block Kit `table`s — Evidence and Recommended
 * Actions. Slack renders them with real columns.
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
  // Never an empty span: Slack rejects one, and the rejection costs the whole message.
  const kept = out.filter((sp) => sp.text !== "");
  return kept.length > 0 ? kept : [{ type: "text", text: text === "" ? "—" : text }];
}

/**
 * The source suffix: ` — _tool_name_ …`, where the Source column is the tool name and EVERYTHING
 * after it.
 *
 * Anchored on the tool name CONTAINING an underscore, which every tool on this server does
 * (`k8s_*`, `prometheus_query`, `loki_query_range`). A finding routinely ends in a backticked
 * value of its own, so splitting on the last dash would put half the sentence in the Source
 * column; requiring the snake_case shape right after the dash is what tells the two apart.
 *
 * The first version also demanded the line END with the tool name plus optional backticked
 * resources, and that was written from the template rather than from what the model writes.
 * Measured on incidents 168 and 169 (2026-09-25), every one of these is real and none of them
 * matched — so all four of 169's findings came back sourceless and the whole section fell back
 * to a bullet list:
 *
 *     — _k8s_get_pod_logs_ `storefront-7ff755c7dd-kpl8z` in `sample-apps`
 *     — _k8s_list_events_ results
 *     — _prometheus_query_ results from prior batch
 *     — _k8s_get_pod_logs_ `namespace="sample-apps"`, pod `checkout-gateway-774f8b79dd-lwhs4`
 *     — _functions.k8s_get_endpoints_ and _functions.k8s_list_ingresses_ (from prior fetch)
 *
 * Hence `.*$`: the discriminator is what follows the dash, not what ends the line. Dots are
 * allowed inside the name for the last of those — the model prefixes `functions.` sometimes.
 */
const SOURCE = /\s+[—–]\s+(_?[a-z][a-z0-9.]*(?:_[a-z0-9.]+)+_?\b.*)$/i;

const BULLET = /^[ \t]*(?:[•*\-–]|\d+\.)[ \t]*/;

/**
 * One ITEM per row, not one line per row.
 *
 * Measured on incident 168 (2026-09-25): the model wrote a multi-line Immediate, its detail
 * carried on two indented sub-bullets underneath, and each of those became a row of its own with
 * an empty first column.
 *
 * INDENTATION decides, not the marker — the first attempt said "unmarked lines are continuations"
 * and those sub-bullets are marked, just nested. A line starts a new item only when it is marked
 * AND sits no deeper than the item it would follow; everything else belongs to the item above.
 *
 * The FIRST line opens an item whether or not it is marked: a section that opens without a bullet
 * is still opening one, and dropping it would lose the finding rather than its shape.
 */
function items(text: string): string[] {
  const out: string[] = [];
  let openedAt = 0; // indent of the line that opened the current item
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    const text_ = raw.replace(BULLET, "").trim();
    if (out.length === 0 || (BULLET.test(raw) && indent <= openedAt)) {
      out.push(text_);
      openedAt = indent;
    } else {
      out[out.length - 1] += ` ${text_}`;
    }
  }
  return out;
}

/**
 * An empty cell is not a cosmetic problem: Slack rejects a rich_text element carrying no text,
 * with `invalid_blocks`, and that error costs the WHOLE message — the card is discarded and the
 * RCA goes out as plain text.
 *
 * Live 2026-09-25: one Evidence line carried no recognisable source, its Source cell came back
 * empty, and two RCAs were posted as plain text because of it. The guards below only refused a
 * table where EVERY source was missing; one missing source among five passed all of them and then
 * took the card down.
 *
 * The placeholder says the cell is empty rather than pretending otherwise, and `hasEmptyCell`
 * checks again at the end of each builder — a fill and a check are not redundant when being wrong
 * costs the whole answer.
 */
const EMPTY = "—";

const cellText = (text: string): string => (text.trim() === "" ? EMPTY : text.trim());

const cell = (text: string): KnownBlock =>
  ({
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: toSpans(cellText(text)) }],
  }) as KnownBlock;

/** Could any cell still reach Slack empty? The last line of defence before the card is built. */
const hasEmptyCell = (rows: Array<[string, string]>): boolean =>
  rows.some(([a, b]) => cellText(a) === "" || cellText(b) === "");

/** Rows as (finding, source) pairs; a line with no recognisable source keeps an empty Source. */
export function evidenceRows(evidence: string): Array<[string, string]> {
  return items(evidence)
    .map((line): [string, string] => {
      const m = line.match(SOURCE);
      return m ? [line.slice(0, m.index).trim(), m[1].trim()] : [line, ""];
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
  if (hasEmptyCell(rows)) return null;

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

/**
 * Recommended Actions as `When | Action`.
 *
 * A better fit for a table than Evidence, because the first column is a closed vocabulary rather
 * than free text: the template asks for exactly `*Immediate:*`, `*Short-term:*` and `*Long-term:*`,
 * in that order. So the rung a reader is looking for stops being something they parse out of a
 * sentence and becomes a column they scan.
 *
 * Immediate is the one the remediation step reads — see the Immediate rules in rca-format.md —
 * which is another reason to give it a cell of its own rather than leave it inside a numbered line.
 */
const RUNG = /^\*{0,2}\s*(Immediate|Short[-\s]?term|Long[-\s]?term)\s*:?\s*\*{0,2}\s*:?\s*/i;

/** Rows as (rung, action). A line with no recognisable rung keeps the whole text as the action. */
export function actionRows(actions: string): Array<[string, string]> {
  return items(actions)
    .map((line): [string, string] => {
      const m = line.match(RUNG);
      // Title-cased from the match rather than echoed: the model writes "short-term", "Short Term"
      // and "Short-term", and three spellings down one column is what a table is supposed to fix.
      return m ? [rung(m[1]), line.slice(m[0].length).trim()] : ["", line];
    });
}

const rung = (raw: string): string => {
  const k = raw.toLowerCase().replace(/[\s-]/g, "");
  return k === "immediate" ? "Immediate" : k === "shortterm" ? "Short-term" : "Long-term";
};

export function actionsTable(actions: string): KnownBlock | null {
  const rows = actionRows(actions);
  if (rows.length < 2 || rows.length > MAX_ROWS) return null;
  if (rows.some(([w, a]) => w.length > MAX_CELL_CHARS || a.length > MAX_CELL_CHARS)) return null;
  // No rung anywhere means the model wrote prose or its own headings, and a When column would be
  // an empty stripe down the card. The numbered list renders that as it is.
  if (rows.every(([w]) => w === "")) return null;
  if (hasEmptyCell(rows)) return null;

  return {
    type: "table",
    // The rung column is never longer than "Short-term", so wrapping it can only break that word
    // across two lines. The action is a sentence and must wrap.
    column_settings: [{ is_wrapped: false }, { is_wrapped: true }],
    rows: [
      [
        { type: "raw_text", text: "When" },
        { type: "raw_text", text: "Action" },
      ],
      ...rows.map(([when, action]) => [cell(when), cell(action)]),
    ],
  } as KnownBlock;
}
