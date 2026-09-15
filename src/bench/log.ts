// Read the committed score history back out.
//
// `bench/results/history.jsonl` is the only part of a run that outlives the machine it ran on,
// and it is written for git rather than for eyes: one dense JSON object per line, ~900 bytes for
// a two-case run and several kilobytes for a full one. Answering "did A08 regress" meant opening
// two lines and diffing them by hand. This renders the same file, adds nothing to it.
//
// Two views because there are two questions. The run table answers "did the score move"; the
// case matrix answers "which case moved", which is the one you actually act on — a rate that
// drops four points does not say whether one case broke or four got flaky.

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface HistoryLine {
  at: string;
  sha: string | null;
  backends: string;
  maxTokens: number;
  cases: number;
  attempts: number;
  pass1: number;
  passK: number;
  passHatK: number;
  axes: Record<string, [number, number]>;
  marks: Record<string, string>;
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
// "2026-09-11T09:07:49.771Z" -> "09-11 16:07" in local time, which is what the terminal that
// ran it showed. A UTC timestamp here and a WIB one in the log cost seven hours of a wrong
// conclusion once already.
const when = (iso: string): string => {
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

export function render(lines: HistoryLine[]): string {
  if (lines.length === 0) return "no runs recorded yet — bench/results/history.jsonl is empty";
  const out: string[] = [];

  out.push(["  #", "when".padEnd(11), "sha".padEnd(14), "size".padEnd(7), "pass@1", "pass@k", "pass^k", "axes"].join("  "));
  for (const [i, l] of lines.entries()) {
    const axes = Object.entries(l.axes)
      .map(([k, [ok, seen]]) => `${k} ${ok}/${seen}`)
      .join("  ");
    out.push(
      [
        String(i + 1).padStart(3),
        when(l.at).padEnd(11),
        (l.sha ?? "-").slice(0, 14).padEnd(14),
        `${l.cases}x${l.attempts}`.padEnd(7),
        pct(l.pass1).padStart(6),
        pct(l.passK).padStart(6),
        pct(l.passHatK).padStart(6),
        axes || "-",
      ].join("  ")
    );
  }

  // Every case any run in the window touched, so a case added halfway through still gets a row
  // and shows blanks before it existed — that blank is information, not a gap.
  const cases = [...new Set(lines.flatMap((l) => Object.keys(l.marks)))].sort();
  const width = Math.max(...lines.map((l) => l.attempts), 3);
  const nameWidth = Math.max(...cases.map((c) => c.length), 4);
  out.push("");
  out.push(["case".padEnd(nameWidth), ...lines.map((_, i) => String(i + 1).padEnd(width))].join("  "));
  for (const c of cases) {
    // A case a run never touched gets one dash per attempt of THAT run, not per attempt of the
    // widest run in the window: "---" beside a five-attempt "....." says the case was absent
    // from a three-attempt run, and "-----" would have read as an absent five-attempt one.
    out.push([c.padEnd(nameWidth), ...lines.map((l) => (l.marks[c] ?? "-".repeat(l.attempts)).padEnd(width))].join("  "));
  }

  const last = lines[lines.length - 1];
  out.push("");
  out.push(`last: ${last.backends}, max_tokens ${last.maxTokens}`);
  return out.join("\n");
}

export function readHistory(path: string, limit: number): HistoryLine[] {
  const all = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryLine);
  return all.slice(-limit);
}

if (process.argv[1]?.endsWith("log.ts") || process.argv[1]?.endsWith("log.js")) {
  const path = join(process.cwd(), "bench", "results", "history.jsonl");
  console.log(render(readHistory(path, Number(flag("runs") ?? 8))));
}
