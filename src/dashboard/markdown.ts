import { esc } from "./html.js";

// A CommonMark SUBSET, sized to what `prompts/` actually contains and nothing else. Counted
// across the core prompt and all 14 skills before writing a line: 124 bullets (one nesting
// level), 72 `**bold**`, 52 inline-code spans, 38 headings over three levels, ~45 ordered
// items, 3 fenced blocks — and every pipe-table row already lives inside a fence, so there is
// no table support here and nothing to add until a table appears outside one.
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

/** `**bold**` and `` `code` ``, applied to text that is ALREADY escaped. */
function inline(escaped: string): string {
  return escaped
    // Code first: a span of code may contain asterisks, and running bold first would eat them.
    // `[^`]+` cannot span a backtick, so an unmatched one is left as the literal it is.
    .replace(/`([^`]+)`/g, '<code translate="no">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** One `- ` / `1. ` item, or null. `indent` is how deep, counted in leading spaces. */
function listItem(line: string): { ordered: boolean; indent: number; text: string } | null {
  const m = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
  if (!m) return null;
  return { ordered: !m[2], indent: m[1]!.length, text: m[4]! };
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
