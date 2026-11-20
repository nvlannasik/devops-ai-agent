// npm run replay:candidates -- [--days 30] [--all]
//
// The replay track (E1, 2026-11-20). Six cases were exported by hand in seven weeks, each one picked
// because someone remembered an incident. This lists the recorded production runs worth a case, from
// the dashboard's /api/replay-candidates (same port-forward and password as replay:export — never
// the production database), ranked by what makes a case worth keeping:
//
//   confirmed  a human root cause exists (learn, ✅, the resolve button) — the only signal that
//              GRADES the RCA: export turns it into answer.must, everything else is a snapshot
//   rejected   on-call rejected the card
//   not fixed  the fix ran and the verdict was unchanged or worse
//   <gate>     the run hit iteration-ceiling / deadline, declined an alert, or advised a never-action
//
// Threads already in replay/cases are left out. It prints the export command for each and exports
// nothing: a trace is reviewed by a person before it is committed (README "Read trace.json").
//   DASHBOARD_URL       default http://localhost:3101
//   DASHBOARD_PASSWORD  required

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Candidate {
  incidentId: number;
  threadTs: string;
  alertname: string;
  namespace: string | null;
  createdAt: string;
  confirmed: boolean;
  rejected: boolean;
  notFixed: boolean;
  gates: string[];
}

export interface Ranked extends Candidate {
  score: number;
  why: string[];
  caseName: string;
}

const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The case name export would accept (`^[a-z0-9][a-z0-9-]{0,60}$`): alert-<alertname>-<main signal>. */
export function caseNameOf(c: Candidate, signal: string): string {
  return `alert-${kebab(c.alertname)}-${signal}`.slice(0, 61).replace(/-+$/, "");
}

export function rank(cands: Candidate[], existing: ReadonlySet<string>, all = false): Ranked[] {
  const out: Ranked[] = [];
  for (const c of cands) {
    if (existing.has(c.threadTs)) continue;
    const why: string[] = [];
    let score = 0;
    if (c.confirmed) (score += 4), why.push("confirmed");
    if (c.rejected) (score += 3), why.push("rejected");
    if (c.notFixed) (score += 3), why.push("not-fixed");
    for (const g of c.gates) (score += 2), why.push(g);
    if (score === 0 && !all) continue;
    out.push({ ...c, score, why, caseName: caseNameOf(c, why[0] ?? "snapshot") });
  }
  // Highest score first; among equals the newest — it ran the code closest to today's.
  return out.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
}

/** Thread ids already exported: every `replay/cases/<name>/trace.json` names its thread. */
export function existingThreads(casesDir: string): Set<string> {
  const out = new Set<string>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(casesDir);
  } catch {
    return out;
  }
  for (const d of dirs) {
    try {
      const t = JSON.parse(readFileSync(join(casesDir, d, "trace.json"), "utf8")) as { thread?: unknown };
      if (typeof t.thread === "string") out.add(t.thread);
    } catch {
      // a directory without a readable trace.json is not a case to dedupe against
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--days");
  const days = i >= 0 ? Number(args[i + 1]) : 30;
  const base = process.env.DASHBOARD_URL ?? "http://localhost:3101";
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) throw new Error("DASHBOARD_PASSWORD is required");

  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`dashboard login failed (HTTP ${login.status})`);
  const res = await fetch(`${base}/api/replay-candidates?days=${days}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`/api/replay-candidates: HTTP ${res.status} ${await res.text()}`);
  const { candidates } = (await res.json()) as { candidates: Candidate[] };

  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const ranked = rank(candidates, existingThreads(join(root, "replay", "cases")), args.includes("--all"));
  console.log(`${candidates.length} recorded incident(s) in ${days} d; ${ranked.length} worth a case (already exported ones left out)\n`);
  for (const r of ranked) {
    console.log(`#${r.incidentId}  ${r.createdAt.slice(0, 16)}  ${r.alertname}${r.namespace ? ` (${r.namespace})` : ""}  — ${r.why.join(", ") || "no signal"}`);
    console.log(`    npm run replay:export -- ${r.threadTs} ${r.caseName}`);
  }
  if (ranked.length) console.log("\nThen read trace.json, and write expect.json to say what the incident SHOULD produce.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
