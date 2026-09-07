/**
 * Benchmark runner — `npm run bench`.
 *
 * Drives the REAL agent: same investigate() the alert webhook calls, same proposal prompt and
 * parser the approval card is built from. A benchmark that reimplements the thing it measures
 * measures the reimplementation.
 *
 * It deliberately does NOT call agent.proposeRemediation(): that stores a row, needs a
 * database, and needs MCP_ENABLE_WRITE_TOOLS to have registered write tools at all. The part
 * under test is the model's judgement, which is buildProposalPrompt + parseProposal — the two
 * pure ends of that method.
 *
 * Requires: a cluster in KUBECONFIG, an MCP server pointed at it, and an LLM backend. Nothing
 * here creates any of the three; see bench/README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DevOpsAgent } from "../agent/index.js";
import { buildGroupAlertText } from "../agent/correlation/index.js";
import { createLLMClient } from "../agent/llm/index.js";
import { buildProposalPrompt, parseProposal, PROPOSAL_SYSTEM, type Proposal } from "../agent/remediation/proposal.js";
import logger from "../utils/logger/index.js";
import { loadCases, type Case } from "./case.js";
import { passRates, scoreProposal, type Score, type TaskRun } from "./score.js";

const CASES_DIR = join(process.cwd(), "bench", "cases");
const RESULTS_DIR = join(process.cwd(), "bench", "results");

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hook(task: Case, script: "setup.sh" | "cleanup.sh"): void {
  const path = join(task.dir, script);
  if (!existsSync(path)) return;
  if (script === "cleanup.sh") {
    // Never throws: it runs in a finally, and an exception here would replace whatever real
    // failure sent us there with a teardown error.
    try {
      execFileSync("bash", [path], { stdio: "inherit", env: process.env });
    } catch (err) {
      logger.error(`[bench] ${task.id} cleanup failed, namespace may be left behind: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  execFileSync("bash", [path], { stdio: "inherit", env: process.env });
}

/** The text blocks of an LLM answer, joined — the agent's own extractText is private to it. */
const textOf = (content: Array<{ type: string; text?: string }>): string =>
  content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

async function attempt(agent: DevOpsAgent, llm: ReturnType<typeof createLLMClient>, task: Case, n: number): Promise<{ score: Score; rca: string; proposal: Proposal | null }> {
  // A fresh thread per attempt. Sharing one would let attempt 2 read attempt 1's conclusion out
  // of conversation memory and score the memory rather than the model.
  const threadId = `bench-${task.id}-${n}-${Date.now()}`;
  const issue = buildGroupAlertText(task.groupLabels, task.alerts, task.commonAnnotations);
  try {
    const rca = await agent.investigate(threadId, issue);
    const res = await llm.chat(
      [{ role: "user", content: buildProposalPrompt(task.groupLabels, rca) }],
      [],
      PROPOSAL_SYSTEM
    );
    const proposal = parseProposal(textOf(res.content as Array<{ type: string; text?: string }>));
    return { score: scoreProposal(task.expect, proposal), rca, proposal };
  } catch (err) {
    // A crashed attempt is a failed attempt, not a crashed run: the other tasks still have
    // something to say, and hiding this one behind an exception would inflate every rate.
    const msg = err instanceof Error ? err.message : String(err);
    return { score: { pass: false, reasons: [`attempt threw: ${msg}`] }, rca: "", proposal: null };
  } finally {
    await agent.clearThread(threadId).catch(() => {});
  }
}

async function main(): Promise<void> {
  const attempts = Number(flag("attempts") ?? 1);
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("--attempts must be a positive integer");
  const filterArg = flag("filter");
  const tasks = loadCases(CASES_DIR, { filter: filterArg ? new RegExp(filterArg) : undefined, all: has("all") });
  if (tasks.length === 0) throw new Error(`no bench cases matched${filterArg ? ` --filter ${filterArg}` : ""}`);

  const agent = new DevOpsAgent();
  await agent.initialize();
  const llm = createLLMClient();

  const runs: TaskRun[] = [];
  const detail: Array<Record<string, unknown>> = [];

  for (const task of tasks) {
    const scores: Score[] = [];
    for (let n = 1; n <= attempts; n++) {
      logger.info(`[bench] ${task.id} attempt ${n}/${attempts} — setup`);
      let score: Score;
      let rca = "";
      let proposal: Proposal | null = null;
      try {
        // A setup that fails is a failed ATTEMPT, not a failed run — same reasoning as the
        // catch inside attempt(). It also must not skip cleanup: the first live run of this
        // harness hit a fault injector that could not fire, and the crash left its namespace
        // behind on the cluster.
        hook(task, "setup.sh");
        if (task.settleSeconds) await sleep(task.settleSeconds * 1000);
        ({ score, rca, proposal } = await attempt(agent, llm, task, n));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        score = { pass: false, reasons: [`setup failed, so the fault was never injected: ${msg}`] };
      } finally {
        hook(task, "cleanup.sh");
      }
      logger.info(`[bench] ${task.id} attempt ${n}: ${score.pass ? "PASS" : `FAIL — ${score.reasons.join("; ")}`}`);
      scores.push(score);
      detail.push({ task: task.id, attempt: n, pass: score.pass, reasons: score.reasons, proposal, rca });
    }
    runs.push({ task: task.id, attempts: scores });
  }

  const rates = passRates(runs);
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  console.log("\n" + "-".repeat(64));
  for (const r of runs) {
    console.log(`${r.task.padEnd(34)} ${r.attempts.map((a) => (a.pass ? "." : "x")).join("")}`);
  }
  console.log("-".repeat(64));
  // With k=1 the three rates are the same number, and printing "pass@1 x pass@1 x pass^1" reads
  // like a bug in the reporter rather than a single-attempt run.
  const line =
    rates.k === 1
      ? `pass@1 ${pct(rates.pass1)}  (one attempt each — run --attempts 5 for consistency)`
      : `pass@1 ${pct(rates.pass1)}   pass@${rates.k} ${pct(rates.passK)}   pass^${rates.k} ${pct(rates.passHatK)}`;
  console.log(`${rates.tasks} cases x ${rates.k} attempts   ${line}`);
  if (rates.k > 1) console.log("pass^k is the one that matters: an agent right four times in five is one whose output must be checked every time.\n");

  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ rates, runs, detail }, null, 2));
  console.log(`full transcript: ${out}`);

  // Non-zero on any inconsistency, so this can gate CI without a second script deciding what
  // "good" means. pass^k, not pass@k — see above.
  process.exit(rates.passHatK === 1 ? 0 : 1);
}

main().catch((err) => {
  logger.error(`[bench] ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
