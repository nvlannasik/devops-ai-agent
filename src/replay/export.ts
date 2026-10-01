// npm run replay:export -- <thread_ts> <case-name> [--run <uuid>]
//
// Turns one recorded production run into a regression case (spec §8.2). Reads the dashboard's
// /api/trace — over the existing port-forward, behind its password — and never the production
// database: the bench's rule that DB_HOST never points at production holds here too.
//   DASHBOARD_URL       default http://localhost:3101
//   DASHBOARD_PASSWORD  required
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { selectRun, type Expect, type TraceEvent } from "./trace.js";
import { redact } from "./redact.js";

const args = process.argv.slice(2);
const runFlag = args.indexOf("--run");
const runId = runFlag >= 0 ? args[runFlag + 1] : undefined;
const [thread, name] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--run");
if (!thread || !/^\d{1,12}\.\d{1,9}$/.test(thread) || !name || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(name)) {
  throw new Error("usage: npm run replay:export -- <thread_ts> <case-name: lowercase, digits, dashes> [--run <uuid>]");
}
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

const res = await fetch(`${base}/api/trace/${thread}`, { headers: { cookie } });
if (!res.ok) throw new Error(`/api/trace/${thread}: HTTP ${res.status} ${await res.text()}`);
const { events } = (await res.json()) as { events: TraceEvent[] };

const { value: trace, hits } = redact(selectRun(events, runId));
const runs = [...new Set(trace.events.map((e) => e.payload.run))];

// A starting point, not a verdict: the observed gates become `must` so the case fails the moment a
// harness change decides this incident differently. Edit it to say what SHOULD happen.
const proposalEnd = trace.events.find(
  (e) => e.kind === "end" && trace.events.some((s) => s.kind === "start" && s.payload.run === e.payload.run && s.payload.phase === "proposal")
);
const expect: Expect = {
  answer: { must: [], mustNot: [] },
  gates: { must: [...new Set(trace.events.filter((e) => e.kind === "gate").map((e) => `${e.name}:${e.outcome}`))], mustNot: [] },
  ...(proposalEnd ? { proposal: { action: proposalEnd.payload.answer?.action ?? null } } : {}),
  allowDiverge: false,
};

const dir = join(fileURLToPath(new URL("../../replay/cases", import.meta.url)), name);
mkdirSync(dir, { recursive: true });
const body = JSON.stringify(trace, null, 2) + "\n";
writeFileSync(join(dir, "trace.json"), body);
writeFileSync(join(dir, "expect.json"), JSON.stringify(expect, null, 2) + "\n");

console.log(`wrote ${dir} — ${trace.events.length} events in ${runs.length} run(s), ${(body.length / 1024).toFixed(0)} KB`);
console.log(hits.length === 0 ? "redactions: none" : `redactions (${hits.length}):\n  ${hits.join("\n  ")}`);
console.log("Review trace.json before committing it, then edit expect.json to say what this incident SHOULD produce.");
