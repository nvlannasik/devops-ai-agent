import { esc } from "./html.js";

// A CommonMark SUBSET, sized to what `prompts/` actually contains and nothing else. Counted
// across the core prompt and all 14 skills before writing a line: 124 bullets (one nesting
// level), 72 `**bold**`, 52 inline-code spans, 38 headings over three levels, ~45 ordered
// items, 3 fenced blocks — and at the time every pipe-table row in those files lived inside a
// fence, so for years there was no table support here and nothing to add until one appeared
// outside one. The postmortem draft's `## Timeline` (`agent/postmortem/facts.ts`,
// `renderFacts`) is that one: a real pipe table, outside a fence, rendered on
// `/incidents/:id/postmortem` — so pipe-table support was added, minimally (below). It is NOT
// the only one any more once added: `prompts/system.md`'s "Pod State Awareness" table also
// sits outside a fence and now renders as a real `<table>` on `/prompt` too — kept rather than
// special-cased away, because it reads better there as well (`markdown.test.ts` pins it).
//
// Hand-rolled rather than a dependency for the reason `rca.ts` is: a parser is 40KB and a
// transitive tree to solve six constructs on two read-only internal pages, and the one thing
// that actually matters here is a rule no library enforces for you —
//
//   ESC FIRST, THEN MARKUP. Never the other way round.
//
// The dashboard's whole posture is that a missed `esc()` is inert because those pages have no
// `script-src` at all. Generating HTML from text is exactly where that stops being free, so
// every line is escaped before a single tag is added and no branch below ever emits a
// caller-supplied character unescaped. Same contract as `rca.ts`, which parses the RCA's Slack
// mrkdwn — DIFFERENT SYNTAX, deliberately not shared: Slack bold is a single `*` and italics
// are `_underscores_`, so one renderer for both would get one of them wrong.

// `**bold**` and `_italic_`/`*italic*`, applied to text that is NOT a code span. Guarded with a
// non-word boundary (or line start/end) immediately outside each delimiter, or `TIMEOUT_MS` and
// `snake_case` in prose would grow an <em> around their own inner underscore. Bold runs first:
// `**x**` is two single-asterisk delimiters stacked, and running italics first would consume the
// outer pair and leave `*<em>x</em>*` — a stray asterisk either side of the emphasis.
function emphasize(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\*)(?=[^\w*]|$)/gm, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\s][^_]*?)_(?!_)(?=[^\w_]|$)/gm, "$1<em>$2</em>");
}

/**
 * `**bold**`, `_italic_`/`*italic*` and `` `code` ``, applied to text that is ALREADY escaped.
 *
 * Code spans are split out FIRST and never see `emphasize()` at all — a span of code is a tool
 * name or a query, rendered byte-identical, and `**k8s_describe_pod**` or `field_selector` must
 * never grow a `<strong>`/`<em>` around its own punctuation. `escaped.split(/(`[^`]+`)/)`
 * alternates plain-text / code-span / plain-text / ...: the capturing group keeps the delimited
 * matches in the result, at every ODD index, so the two cases are told apart by position rather
 * than by re-matching the backticks a second time.
 */
function inline(escaped: string): string {
  return escaped
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 === 1 ? `<code translate="no">${part.slice(1, -1)}</code>` : emphasize(part)))
    .join("");
}

/** One `- ` / `1. ` item, or null. `indent` is how deep, counted in leading spaces. */
function listItem(line: string): { ordered: boolean; indent: number; text: string } | null {
  const m = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
  if (!m) return null;
  return { ordered: !m[2], indent: m[1]!.length, text: m[4]! };
}

// Pipe tables: added for the postmortem draft's `## Timeline` (facts.ts's renderFacts), the
// only place this dashboard renders one. Deliberately minimal — header row, separator row, body
// rows, no alignment colons honoured, no column-count enforcement — because that is the whole
// shape `renderFacts` ever emits. `|` splits on an UNESCAPED pipe only: facts.ts's `escCell`
// writes `\|` for a literal pipe inside a cell (and strips newlines), so `\|` has to come back
// as a literal `|` in the rendered cell rather than staying a visible backslash or reopening a
// column — the inverse of what escCell did going in.
//
// A table is recognised only when the NEXT line is a separator row (cells of `-`, optionally
// `:`-bound) — a bare "|" in prose must not become a one-cell table just because it contains the
// character.
function splitTableRow(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/);
  // A row is `| a | b |`: splitting on every unescaped pipe produces a leading and a trailing
  // empty string from the OUTER delimiters, never from an inner one — drop those two, not every
  // empty entry, so a genuinely empty cell in the middle still counts as one.
  if (parts.length > 0 && parts[0]!.trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}

function isTableSeparatorRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Markdown → HTML for the prompt and skill pages.
 *
 * Headings start at `<h3>`: the page itself already owns `<h1>` (its title) and `<h2>` (its
 * sections), so a `#` in a prompt file is the third level of THIS document even though it is
 * the first of its own. Emitting `<h1>` here would put two on the page and break the sequence
 * a screen reader navigates by.
 */
export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let i = 0;
  // Open list stack, so one level of nesting closes in the right order.
  let open: ("ul" | "ol")[] = [];

  const closeLists = (toDepth = 0): void => {
    while (open.length > toDepth) out.push(`</${open.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced block. Verbatim and escaped, with NO inline markup: these hold LogQL and PromQL
    // that `skills/real.test.ts` parses and an operator retypes, so a backtick or an asterisk
    // inside one is part of the query, not formatting.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      closeLists();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i]!), i++;
      i++; // the closing fence, or the end of input if it was never closed
      out.push(`<pre class="md-code"><code translate="no">${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      closeLists();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeLists();
      const level = Math.min(heading[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(esc(heading[2]!))}</h${level}>`);
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1]!)) {
      closeLists();
      // esc() before inline() before the surrounding tag, the same order every other branch
      // here uses — and the unescape of `\|` happens FIRST, on the raw cell, so the literal
      // pipe it restores is never re-interpreted as markup or as a column delimiter: esc()
      // does not touch `|` at all, so this is purely "undo escCell", not a second escaping pass.
      const cellHtml = (c: string): string => inline(esc(c.replace(/\\\|/g, "|")));
      const head = splitTableRow(line);
      i += 2; // the header row and the separator row
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().length > 0 && lines[i]!.includes("|")) {
        bodyRows.push(splitTableRow(lines[i]!));
        i++;
      }
      const thead = head.map((c) => `<th>${cellHtml(c)}</th>`).join("");
      const tbody = bodyRows.map((r) => `<tr>${r.map((c) => `<td>${cellHtml(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    const item = listItem(line);
    if (item) {
      // One nesting level is all `prompts/` uses; deeper indents flatten into it rather than
      // opening lists nothing closes.
      const depth = item.indent > 0 ? 2 : 1;
      const tag = item.ordered ? "ol" : "ul";
      if (open.length > depth) closeLists(depth);
      if (open.length === depth && open[depth - 1] !== tag) {
        closeLists(depth - 1);
      }
      while (open.length < depth) {
        out.push(`<${tag}>`);
        open.push(tag);
      }
      out.push(`<li>${inline(esc(item.text))}</li>`);
      i++;
      continue;
    }

    closeLists();
    // A paragraph runs until a blank line or anything that starts a block.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !listItem(lines[i]!) && !/^(#{1,6}\s|```)/.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inline(esc(para.join("\n")))}</p>`);
  }

  closeLists();
  return out.join("");
}
