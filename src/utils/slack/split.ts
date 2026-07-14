// Slack hard-splits messages longer than ~4000 chars into multiple messages, which
// breaks ``` code fences (the continuation renders as raw text). Split ourselves at
// newline boundaries and re-balance fences so every chunk renders correctly.
const SLACK_MAX_CHARS = 3800; // stay under Slack's ~4000 split point, leave room for the closing fence

export function splitForSlack(text: string, max = SLACK_MAX_CHARS): string[] {
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
