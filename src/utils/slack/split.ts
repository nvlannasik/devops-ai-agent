// Slack hard-splits messages longer than ~4000 chars into multiple messages, which
// breaks ``` code fences (the continuation renders as raw text). Split ourselves at
// newline boundaries and re-balance fences so every chunk renders correctly.
const SLACK_MAX_CHARS = 3800; // stay under Slack's ~4000 split point, leave room for the closing fence

// Slack mrkdwn is not Markdown, and the model writes Markdown. Both conversions below run
// OUTSIDE code fences only, so log excerpts and YAML in ``` blocks are never rewritten.
//
// `**bold**` → `*bold*`: Slack bolds with a single asterisk and renders the double form
// literally.
//
// `### Heading` → `*Heading*`: Slack has no headings AT ALL, so three hashes reach the reader as
// three hashes. Observed 2026-09-16 in a live conversation thread, and it is a regression this
// repo caused itself: the syntax rules ("no ## headers", bullets, italics) live in
// `prompts/skills/rca-format.md`, which was `when: always` until the mode tag was added. They
// were riding along on every casual mention by accident, and scoping that skill to alert and
// investigation mode took them out of conversation mode with it. The rules are back in the
// conversation block of `prompts/system.md` now — but a prompt rule alone has never held on a
// small model in this repo, which is what the deterministic half is for.
//
// ponytail: line-anchored, so a `#` mid-sentence is untouched and `#1` is not a heading. Known
// ceiling — a bare `# comment` line of shell or YAML sitting OUTSIDE a fence becomes bold. The
// prompt tells the model to fence exactly that content, and the alternative is a Markdown parser
// for one cosmetic case.
const MD_HEADING = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;

export function toMrkdwn(text: string): string {
  return text
    .split("```")
    .map((seg, i) =>
      i % 2 === 0
        ? seg
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            // Asterisks inside the title are dropped rather than nested: `*a *b* c*` closes the
            // span early in Slack and the rest of the line loses its formatting.
            .replace(MD_HEADING, (_m, title: string) => `*${title.replace(/\*/g, "").trim()}*`)
        : seg
    )
    .join("```");
}

export function splitForSlack(text: string, max = SLACK_MAX_CHARS): string[] {
  text = toMrkdwn(text);
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // cut at the last newline before the limit so lines stay intact
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    let chunk = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");

    // odd number of ``` = chunk ends inside an open code block → close it here,
    // reopen at the start of the remainder so both chunks render as code
    const fenceCount = (chunk.match(/```/g) ?? []).length;
    if (fenceCount % 2 === 1) {
      chunk += "\n```";
      rest = "```\n" + rest;
    }
    chunks.push(chunk);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
