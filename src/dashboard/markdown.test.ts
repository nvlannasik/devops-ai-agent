import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { renderMarkdown } from "./markdown.js";

// THE test this module exists to pass. These pages have no `script-src` at all, which is what
// makes a missed esc() inert everywhere else on the dashboard — generating HTML from text is
// exactly where that stops being free.
test("markup never comes from the source text", () => {
  const html = renderMarkdown([
    "# <script>alert(1)</script>",
    "",
    "- an <img src=x onerror=alert(1)> item",
    "",
    "**<b>bold</b>** and `<i>code</i>`",
    "",
    "```",
    "<script>alert(2)</script>",
    "```",
  ].join("\n"));
  assert.doesNotMatch(html, /<script|<img|<b>|<i>/, "no tag may survive from the source");
  // ...and it is still READABLE as the text it is, not silently dropped.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// Headings start at h3: the page owns h1 (its title) and h2 (its sections), so a `#` in a
// prompt file is the third level of THIS document. Two h1s would break the sequence a screen
// reader navigates by.
test("headings continue the page's hierarchy instead of restarting it", () => {
  assert.match(renderMarkdown("# One"), /^<h3>One<\/h3>$/);
  assert.match(renderMarkdown("## Two"), /^<h4>Two<\/h4>$/);
  assert.match(renderMarkdown("### Three"), /^<h5>Three<\/h5>$/);
  assert.doesNotMatch(renderMarkdown("# One"), /<h1>|<h2>/);
});

// A fenced block holds LogQL and PromQL that skills/real.test.ts parses and an operator
// retypes. A backtick or an asterisk inside one is part of the query, not formatting.
test("a fenced block is verbatim, with no inline markup applied", () => {
  const html = renderMarkdown(["```logql", '{namespace="x"} |= `**not bold**`', "```"].join("\n"));
  assert.match(html, /<pre class="md-code"><code translate="no">/);
  assert.doesNotMatch(html, /<strong>/, "asterisks inside a fence are query text");
  assert.match(html, /\*\*not bold\*\*/);
});

test("an unclosed fence still terminates instead of eating the rest of the page", () => {
  const html = renderMarkdown("```\nstranded\n");
  assert.match(html, /stranded/);
  assert.match(html, /<\/code><\/pre>/);
});

// Code before bold, because a code span may contain asterisks and the other order eats them.
test("inline code wins over bold when they overlap", () => {
  assert.match(renderMarkdown("`a ** b`"), /<code translate="no">a \*\* b<\/code>/);
  assert.match(renderMarkdown("**b**"), /<strong>b<\/strong>/);
  // An unmatched backtick is the literal it is, not an unterminated element.
  assert.doesNotMatch(renderMarkdown("a ` b"), /<code/);
});

test("lists nest one level and close in order", () => {
  const html = renderMarkdown(["- one", "   - nested", "- two"].join("\n"));
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.equal((html.match(/<\/ul>/g) || []).length, 2);
  assert.match(html, /<li>one<\/li><ul><li>nested<\/li><\/ul><li>two<\/li>/);
});

test("ordered and unordered lists do not bleed into each other", () => {
  const html = renderMarkdown(["- bullet", "1. numbered"].join("\n"));
  assert.match(html, /<ul>.*<\/ul><ol>.*<\/ol>/);
});

// Every tag this module opens has to close, or the page's own layout comes apart below it.
// Asserted over the REAL prompt and every shipped skill, not a fixture — the same trick
// skills/real.test.ts uses, and the only thing that catches a construct nobody anticipated.
test("the shipped prompt and every skill render to balanced markup", async () => {
  const dir = new URL("../../prompts/", import.meta.url);
  const files = [new URL("system.md", dir)];
  for (const f of await readdir(new URL("skills/", dir))) {
    if (f.endsWith(".md")) files.push(new URL(`skills/${f}`, dir));
  }
  assert.ok(files.length >= 10, `expected the shipped skills, found ${files.length - 1}`);

  for (const file of files) {
    const html = renderMarkdown(await readFile(file, "utf8"));
    for (const tag of ["ul", "ol", "li", "p", "pre", "code", "strong"]) {
      const open = (html.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
      const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
      assert.equal(open, close, `${file.pathname.split("/").pop()}: unbalanced <${tag}>`);
    }
    assert.doesNotMatch(html, /<script|onerror=|javascript:/i, `${file.pathname}`);
  }
});
