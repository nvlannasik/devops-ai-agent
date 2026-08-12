import { cell, esc, headers, table } from "./html.js";

// The RCA is the one field on this dashboard a model WROTE rather than measured, and it
// arrives in **Slack mrkdwn**, not CommonMark. `prompts/system.md` pins the grammar: bold is
// a *single* asterisk, italic is _underscores_, code is `backticks`, blocks are ``` fences,
// bullets are the • character, and there are no # headings at all — sections are announced by
// a line that is entirely one bold run (`*📍 Root Cause*`). A Markdown parser would read almost
// none of that correctly, which is why this is hand-written rather than a dependency.
//
// What it buys: each section rendered as the thing it is. Root Cause and Impact are arguments,
// so they stay prose. Evidence, Ruled Out and Recommended Actions are two-column facts —
// claim and source, hypothesis and refutation, horizon and action — so they become tables.
//
// SECURITY — the rule this file exists under. This is untrusted model output rendered on a
// page whose CSP has no `script-src` at all, and both halves of that have to keep holding.
// Every text node is passed through esc() BEFORE any markup is added, so by the time a
// <strong> or a <code> is inserted the string provably contains no `<` or `>` of its own:
// there is no ordering in which model output can close a tag this file opened. The tag set is
// fixed and small, and no attribute value is ever built from parsed text.
//
// It degrades instead of guessing. A body that does not look like the template parses to
// null and renderRca() falls back to the plain block the page used before — a model that
// ignores the format loses its formatting, never its content.

export interface RcaField {
  label: string;
  value: string;
}
export interface RcaRow {
  left: string;
  right: string;
}
export interface RcaBlock {
  code: boolean;
  text: string;
}
export type RcaBody =
  | { kind: "prose"; blocks: RcaBlock[] }
  | { kind: "list"; lead: string; items: string[] }
  | { kind: "rows"; lead: string; columns: [string, string]; rows: RcaRow[] };
export interface RcaSection {
  /** "" for anything the model wrote before its first section header. */
  title: string;
  body: RcaBody;
}
export interface Rca {
  fields: RcaField[];
  sections: RcaSection[];
}

// A line that is entirely one bold run opens a section. A bold run whose text ends in a colon,
// with content after it, is a field instead (`*🔴 Severity:* \`Critical\``) — anchoring the
// colon immediately before the closing asterisk is what keeps `*Impact: what breaks*` a
// heading rather than a field.
const HEADING = /^\*([^*\n]+)\*$/;
const FIELD = /^\*([^*\n]+?):\*\s*(.+)$/;
const FENCE = /^\s*```/;
// Group 1 is a bullet marker, group 2 an ordinal — which one matched decides whether the
// section is a set of facts or a sequence of steps. `-` and `*` are not mrkdwn bullets but
// models reach for them anyway, and a `*` bullet needs the trailing space to stay distinct
// from a bold run.
const MARK = /^\s*(?:([•‣▪·])[ \t]*|([-*+])[ \t]+|(\d+)[.)][ \t]+)/;
// The separator the template puts between a claim and its source. An em dash first: a model
// that writes ` - ` means the same thing, but a hyphen also appears inside ordinary prose, so
// only the first occurrence in a line is ever treated as the split.
const SPLIT = /\s+[—–]\s+|\s+--?\s+/;
// `N. *Immediate:* …` — the label is the horizon, the rest is the action.
const STEP_LABEL = /^\*([^*\n]+?):?\*\s*(.*)$/;

// Column headers for the sections the template names. An unrecognised section never invents
// headers for itself: it renders as a list, which asserts nothing about what its two halves
// mean. Keys are the titles with their emoji stripped and lowercased.
const COLUMNS: Record<string, [string, string]> = {
  evidence: ["Finding", "Source"],
  "ruled out": ["Hypothesis", "Why it was excluded"],
  "recommended actions": ["Horizon", "Action"],
};

// Section titles and field labels arrive with a leading emoji. It is signal in Slack, where
// the RCA is skimmed in a scrolling channel; here the page already has headings, and a
// coloured glyph would be the one bit of decorative colour on a page whose whole premise is
// that colour means severity. Stripped for display, never used for matching.
const clean = (s: string): string => s.replace(/^[^\p{L}\p{N}]+/u, "").trim() || s.trim();

const blank = (s: string): boolean => s.trim() === "";

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && blank(lines[a])) a++;
  while (b > a && blank(lines[b - 1])) b--;
  return lines.slice(a, b);
}

// Splits a section body at its ``` fences. Whatever is inside a fence is a log excerpt or a
// stack trace: it must survive verbatim, and nothing in it may be read as a bullet, a heading
// or emphasis. An unclosed fence leaves its tail as code, which is the reading that loses
// least — the alternative marks up a stack trace.
function toBlocks(lines: string[]): RcaBlock[] {
  const blocks: RcaBlock[] = [];
  let buf: string[] = [];
  let code = false;
  const flush = (): void => {
    const body = trimBlank(buf);
    if (body.length > 0) blocks.push({ code, text: body.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      flush();
      code = !code;
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function splitOnce(s: string): RcaRow {
  const m = SPLIT.exec(s);
  return m
    ? { left: s.slice(0, m.index).trim(), right: s.slice(m.index + m[0].length).trim() }
    : { left: s.trim(), right: "" };
}

function classify(key: string, lines: string[]): RcaBody {
  const blocks = toBlocks(lines);
  // A section carrying a code fence is prose, whatever else is in it. Tabulating around a
  // stack trace would mean deciding which of its lines are cells; leaving the whole section
  // as prose keeps every character and only forgoes the columns.
  if (blocks.length !== 1 || blocks[0].code) return { kind: "prose", blocks };

  const lead: string[] = [];
  const items: string[] = [];
  let ordered = false;
  for (const line of blocks[0].text.split("\n")) {
    const m = MARK.exec(line);
    if (m) {
      if (items.length === 0) ordered = m[3] !== undefined;
      items.push(line.slice(m[0].length).trim());
    } else if (items.length === 0) {
      lead.push(line);
    } else if (!blank(line)) {
      // A wrapped bullet. Models break long evidence lines, and a continuation dropped on
      // the floor is exactly the kind of loss that is invisible until it matters.
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  if (items.length === 0) return { kind: "prose", blocks };

  const rows = items.map((it) => {
    if (!ordered) return splitOnce(it);
    const m = STEP_LABEL.exec(it);
    return m ? { left: clean(m[1]), right: m[2].trim() } : { left: "", right: it };
  });
  const columns = COLUMNS[key] ?? (ordered ? (["Step", "Action"] as [string, string]) : null);
  const leadText = trimBlank(lead).join("\n");
  // One row with an empty right half is a model being terse; none of them having one means
  // the split found nothing real, and a table with a dead column is worse than a list.
  if (columns && rows.some((r) => r.right)) return { kind: "rows", lead: leadText, columns, rows };
  return { kind: "list", lead: leadText, items };
}

/**
 * Parses one RCA. Returns null when the text does not look like the template — fewer than two
 * section headings — which is the caller's signal to render it plainly instead. Two rather
 * than one: a single whole-line bold run is a sentence a model emphasised, and treating that
 * as a heading would restructure a document that has no structure.
 */
export function parseRca(raw: string): Rca | null {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const fields: RcaField[] = [];
  const bufs: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
  let fenced = false;

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      bufs[bufs.length - 1].lines.push(line);
      continue;
    }
    if (!fenced) {
      const t = line.trim();
      const f = FIELD.exec(t);
      if (f) {
        fields.push({ label: clean(f[1]), value: f[2].trim() });
        continue;
      }
      const h = HEADING.exec(t);
      if (h) {
        bufs.push({ title: clean(h[1]), lines: [] });
        continue;
      }
    }
    bufs[bufs.length - 1].lines.push(line);
  }

  const sections = bufs
    .map((b) => ({ title: b.title, body: classify(b.title.toLowerCase(), b.lines) }))
    .filter((s) => !(s.body.kind === "prose" && s.body.blocks.length === 0));
  if (sections.filter((s) => s.title).length < 2) return null;
  return { fields, sections };
}

/**
 * Inline mrkdwn → HTML. esc() runs on every fragment first and is what makes the rest safe:
 * an escaped string holds no `<` or `>`, so the tags added afterwards are provably this
 * file's own. Code spans are lifted out before emphasis is applied, so a `*` or `_` inside
 * `kubectl -o jsonpath={.spec}` stays a literal character.
 */
export function inlineMrkdwn(raw: string): string {
  return raw
    .split(/(`[^`\n]+`)/)
    .map((part) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? `<code translate="no">${esc(part.slice(1, -1))}</code>`
        : emphasis(esc(part))
    )
    .join("");
}

// The italic rule is bounded on both sides on purpose. Half the identifiers on this page are
// snake_case, and an unbounded /_(.+?)_/ turns `k8s_list_pods` into k8s<em>list</em>pods.
// Requiring whitespace or an opening bracket before the marker, and whitespace, punctuation
// or end-of-string after it, is what tells the two apart — an underscore with a letter on
// its left cannot open emphasis, so `k8s_list_pods` has no candidate opener at all.
//
// The span itself must be allowed to CONTAIN underscores, because the thing the template
// actually italicises is a tool name: `_k8s_list_pods_`. Excluding them from the span looks
// safer and is not — it just means the one form the prompt asks for never matches, and the
// markers render as literal underscores in the Source column.
function emphasis(escaped: string): string {
  return escaped
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s([])_([^\n]+?)_(?=$|[\s.,;:!?)\]])/g, "$1<em>$2</em>");
}

const proseCard = (inner: string): string => `<div class="prose">${inner}</div>`;

function renderBody(body: RcaBody): string {
  if (body.kind === "prose") {
    return proseCard(
      body.blocks
        .map((b) =>
          b.code
            ? `<pre class="rca-code" translate="no"><code>${esc(b.text)}</code></pre>`
            : `<div class="prose-text">${inlineMrkdwn(b.text)}</div>`
        )
        .join("")
    );
  }
  const lead = body.lead ? `<div class="prose-text">${inlineMrkdwn(body.lead)}</div>` : "";
  if (body.kind === "list") {
    return proseCard(
      lead + `<ul class="rca-list">${body.items.map((i) => `<li>${inlineMrkdwn(i)}</li>`).join("")}</ul>`
    );
  }
  const head = headers(body.columns[0], body.columns[1]);
  const rows = body.rows
    .map(
      (r) =>
        `<tr role="row">` +
        cell(body.columns[0], r.left ? inlineMrkdwn(r.left) : `<span class="meta">—</span>`, "primary") +
        cell(body.columns[1], inlineMrkdwn(r.right)) +
        `</tr>`
    )
    .join("");
  // Two columns still do not fit a phone when the left one is a whole finding: "OOMKilled, exit
  // code 137" against a 5rem Source column pushed the tool name off the edge, which is exactly
  // the half a reader needs to check the claim. Stacked, the finding keeps the width and its
  // source sits underneath it.
  return (lead ? proseCard(lead) : "") + table(head, rows, "stack");
}

const fieldStrip = (items: RcaField[], cls: string): string =>
  items.length === 0
    ? ""
    : `<dl class="${cls}">` +
      items.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${inlineMrkdwn(f.value)}</dd></div>`).join("") +
      `</dl>`;

// The two sections the template ends on are verdicts, not argument: a word, or a word and the
// one line that justifies it. Rendered like every other section they each spend a heading and a
// full-width panel on eight characters — a third of a phone screen, below the evidence, saying
// "critical". As a strip they read as what they are: the finding, stated once, where the
// template already puts it. Matched by name and lowercased, the same convention COLUMNS uses;
// a section this file does not recognise keeps its panel and asserts nothing.
const VERDICTS = new Set(["severity", "confidence"]);

// Only a body that is genuinely one line. A model that argues its confidence across three
// bullets has written an argument, and an argument does not fit on a strip.
function oneLine(body: RcaBody): string | null {
  if (body.kind !== "prose" || body.blocks.length !== 1) return null;
  const [b] = body.blocks;
  return !b.code && !b.text.includes("\n") ? b.text : null;
}

/**
 * The RCA as HTML: section by section when it follows the template, and the plain block the
 * page rendered before when it does not.
 */
export function renderRca(raw: string): string {
  const parsed = parseRca(raw);
  if (!parsed) return proseCard(`<div class="prose-text">${esc(raw)}</div>`);

  const verdicts: RcaField[] = [];
  const body = parsed.sections
    .filter((s) => {
      const line = VERDICTS.has(s.title.toLowerCase()) ? oneLine(s.body) : null;
      if (line === null) return true;
      verdicts.push({ label: s.title, value: line });
      return false;
    })
    .map((s) => (s.title ? `<h3 class="rca-head">${esc(s.title)}</h3>` : "") + renderBody(s.body))
    .join("");

  // The model's own inline fields lead, because it wrote them as a preamble. The promoted
  // verdicts trail, because the evidence they rest on is above them.
  return (
    `<div class="rca">${fieldStrip(parsed.fields, "rca-fields")}${body}` +
    `${fieldStrip(verdicts, "rca-fields verdicts")}</div>`
  );
}
