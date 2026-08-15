export interface Frontmatter {
  keys: Record<string, string>;
  body: string;
}

const DELIM = "---";

/**
 * Flat `key: value` frontmatter, hand-parsed because the repo has no YAML parser and one
 * un-nested block does not justify adding one. Deliberately unforgiving: every rejection here
 * is a file that would otherwise load as a silently different skill.
 *
 * `file` is only ever used to name the offender in the message — this parser reads nothing.
 */
export function parseFrontmatter(text: string, file: string): Frontmatter {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== DELIM) {
    throw new Error(`${file}: expected "---" on the first line`);
  }
  const end = lines.indexOf(DELIM, 1);
  if (end === -1) {
    throw new Error(`${file}: frontmatter is not closed by a "---" line`);
  }

  const keys: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    // First colon, not last: a `when` pattern may legitimately contain one.
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`${file}: line ${i + 1} is not "key: value" — ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, colon).trim();
    if (key in keys) throw new Error(`${file}: duplicate key "${key}"`);
    keys[key] = line.slice(colon + 1).trim();
  }

  // slice(end + 1) — only the first closing delimiter counts, so a body may contain its own.
  return { keys, body: lines.slice(end + 1).join("\n").trim() };
}
