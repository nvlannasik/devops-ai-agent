/**
 * Benchmark runner — `npm run bench`.
 *
 * Drives the REAL agent: same investigate() the alert webhook calls, same proposal prompt and
 * parser the approval card is built from. A benchmark that reimplements the thing it measures
 * measures the reimplementation.
 *
 * It deliberately does NOT call agent.proposeRemediation(): that stores a row, needs a
 * database, and needs MCP_ENABLE_WRITE_TOOLS to have registered write tools at all. The part
 * under test is the model's judgement, which is proposeWithRetry — the pure middle of that
 * method, prompt and parser and the one re-ask, with only the storage ends removed.
 *
 * Requires: a cluster in KUBECONFIG, an MCP server pointed at it, and an LLM backend. Nothing
 * here creates any of the three; see bench/README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DevOpsAgent } from "../agent/index.js";
import { buildGroupAlertText } from "../agent/correlation/index.js";
import { buildMentionMarker } from "../agent/prompts/system.js";
import { parseOffer, worthProposing } from "../agent/remediation/proposal.js";
import { buildProposalContext } from "../app/index.js";
import { offerMismatchRefusal } from "../agent/index.js";
import { withRoute } from "../utils/trace/index.js";
import { createLLMClient } from "../agent/llm/index.js";
import { proposeWithRetry, PROPOSAL_SYSTEM, type Proposal } from "../agent/remediation/proposal.js";
import logger from "../utils/logger/index.js";
import { loadCases, type Case } from "./case.js";
import { combine, passRates, scoreGrounding, scoreProposal, scoreRca, type Score, type TaskRun } from "./score.js";
import { appendHistory, axisTally, publishHistory, runMeta } from "./store.js";
import { config } from "../config/index.js";
import { parseRegistry } from "../agent/llm/registry.js";

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

/**
 * Incident memory must start every attempt empty.
 *
 * Recall is cross-thread BY DESIGN — that is what it is for — so with the database on, attempt 2
 * of a case reads attempt 1's incident back as a "Prior similar incident", and the score stops
 * measuring the model and starts measuring the run order. Emptying it per attempt is what keeps
 * the three attempts of a case independent, which is the whole basis of pass^k.
 *
 * This deliberately leaves the recall PATH unmeasured rather than measuring it by accident. A
 * tier-D case that wants a populated table should seed it in its own `setup.sh`, where the prior
 * incident is a fixture with known content — not a leftover whose text depends on what the model
 * happened to say twenty minutes earlier.
 *
 * `schema_migrations` is excluded: emptying it makes the next `initialize()` re-run every
 * migration against tables that already exist.
 */
async function resetIncidentMemory(): Promise<void> {
  if (!process.env.DB_HOST) return; // memory disabled — nothing to reset, and no client to build
  const { Pool } = await import("pg");
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME, // DB_USERNAME, not DB_USER — config/index.ts reads that name
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
    );
    const names = rows.map((r) => `"${r.tablename}"`).join(", ");
    if (names) await pool.query(`${"TRUNCATE"} ${names} RESTART IDENTITY CASCADE`);
  } catch (err) {
    // Same reasoning as waitForIsolation: a reset that cannot run is a contaminated attempt worth
    // saying so about, not a reason to end a five-hour run.
    logger.warn(`[bench] could not reset incident memory: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Nothing from another case may be alive when this one starts.
 *
 * Every `cleanup.sh` deletes with `--wait=false`, which returns while the namespace is still
 * Terminating with its pods running. The agent's tool calls are not namespace-scoped by default,
 * so the previous case stays visible for as long as that takes — and it is the loudest thing on
 * the cluster, because it is a fault someone injected on purpose. Measured: C01, whose whole
 * point is that nothing is wrong, proposed a rolling restart of `bench-b04/payments` while
 * bench-b04 was on its way out with eight crashlooping pods.
 *
 * Checked here rather than fixed by making every cleanup wait: this also catches a namespace left
 * behind by a crashed run, which no cleanup script would have run at all, and a new case cannot
 * forget to opt in.
 *
 * Never throws. A namespace wedged on a finalizer is a reason to say so and carry on, not to end
 * a five-hour run — the attempt that follows is contaminated, and the log line is what says which.
 */
async function waitForIsolation(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let left: string[] = [];
  while (Date.now() < deadline) {
    try {
      left = execFileSync("kubectl", ["get", "ns", "-o", "name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\n")
        .map((l) => l.replace("namespace/", "").trim())
        .filter((n) => n.startsWith("bench-"));
    } catch {
      return; // no cluster reachable is the attempt's problem to report, not this gate's
    }
    if (left.length === 0) return;
    await sleep(3000);
  }
  logger.warn(`[bench] ${left.join(", ")} still present after ${timeoutMs / 1000}s — the next attempt can see it`);
}

/** The text blocks of an LLM answer, joined — the agent's own extractText is private to it. */
const textOf = (content: Array<{ type: string; text?: string }>): string =>
  content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

async function attempt(agent: DevOpsAgent, llm: ReturnType<typeof createLLMClient>, task: Case, n: number): Promise<{ score: Score; rca: string; proposal: Proposal | null; proposalRaw: string; ungrounded: string[] }> {
  // A fresh thread per attempt. Sharing one would let attempt 2 read attempt 1's conclusion out
  // of conversation memory and score the memory rather than the model.
  const threadId = `bench-${task.id}-${n}-${Date.now()}`;
  // The same door production uses, for whichever mode the case declares. A mention is wrapped in
  // buildMentionMarker because that wrapper IS the input on that path — it restates the thread's
  // alertname and namespace, and an investigation that never sees it is not the one Slack runs.
  const issue = task.mode === "alert"
    ? buildGroupAlertText(task.groupLabels!, task.alerts!, task.commonAnnotations)
    : buildMentionMarker(task.message!, null);
  // Conversation mode is the only one with a finite tool budget, and that is load-bearing: the
  // namespace scope lock and the log fan-out cap only engage when the budget is finite. A
  // conversation case run with an infinite budget would silently test neither.
  const budget = task.mode === "conversation" ? { maxToolRounds: config.mentionToolRounds } : {};
  try {
    const run = () => agent.investigate(threadId, issue, { ...budget, mode: task.mode });
    // The light route for a conversation mention, heavy for everything else — app/index.ts makes
    // exactly this split, and running a cheap-tier question on the heavy chain measures a model
    // production would not have used.
    let rca = task.mode === "conversation" ? await withRoute("light", run) : await run();
    // A second turn in the SAME thread, when the case has one. `previousReply` is read between
    // the turns for the same reason app/index.ts reads it there: after the follow-up runs, the
    // last assistant message is the follow-up's own answer. Raw from memory, marker and all —
    // that is what production hands the gate.
    let previousReply = "";
    if (task.followUp) {
      previousReply = await agent.lastAssistantText(threadId).catch(() => "");
      const second = () => agent.investigate(threadId, buildMentionMarker(task.followUp!, null), { ...budget, mode: task.mode });
      rca = task.mode === "conversation" ? await withRoute("light", second) : await second();
    }
    // BEFORE the finally clears the thread: grounding is checked against this run's own tool
    // results, which live in the conversation memory the teardown is about to drop.
    const ungrounded = await agent.ungroundedNames(threadId, rca, issue).catch(() => [] as string[]);
    // proposeWithRetry, not a bare parseProposal, for the same reason the guards are applied by
    // hand below: production gets one re-ask on a self-contradicting answer, and a benchmark
    // that skips it measures a model production does not run.
    //
    // Its raw text is kept whether or not it parsed. No proposal is three different failures
    // wearing one face — the model judged that no whitelisted action fits ({"action": null}), or
    // it emitted prose the brace match mangled, or zod rejected a field — and they need three
    // different fixes. Without this the first live 5-attempt run could only report "no proposal"
    // four times and could not say which.
    // The alert path proposes unconditionally — an alert firing IS the evidence. A mention is
    // gated by worthProposing, and skipping that here would spend a proposal call production
    // never makes: "write me a Python script" must reach the scorer with no proposal at all.
    const offer = parseOffer(await agent.lastAssistantText(threadId).catch(() => ""));
    const gate =
      task.mode === "alert"
        ? { propose: true }
        : worthProposing(task.followUp ?? task.message!, rca, false, previousReply, offer);
    const asked = gate.propose
      ? await proposeWithRetry(
          task.groupLabels ?? {},
          // Production's own context, from the same function — a benchmark that builds its own
          // measures a prompt production does not send.
          task.mode === "alert" ? rca : buildProposalContext(task.followUp ?? task.message!, rca, offer, previousReply),
          async (prompt) =>
          textOf((await llm.chat([{ role: "user", content: prompt }], [], PROPOSAL_SYSTEM)).content as Array<{ type: string; text?: string }>)
        )
      : { proposal: null, raw: "[worthProposing] no proposal call — read-only question, no fault evidence" };
    let proposalRaw = asked.raw;
    let proposal = asked.proposal;
    // The guards run inside proposeRemediation, which this runner deliberately skips — so they
    // are applied here through the agent's own method. Without them the bench would score a card
    // production never posts: a refusal means no approval card, which is the same outcome as no
    // proposal and has to be scored as one. One call, not a per-guard check: which actions a
    // guard applies to is the guard's business, and the previous split let the two drift.
    if (proposal) {
      const refusal =
        (await agent.guardRefusalFor(proposal).catch(() => null)) ??
        offerMismatchRefusal(proposal, offer) ??
        (await agent.targetRefusalFor(proposal, threadId, task.groupLabels ?? {}).catch(() => null)) ??
        (await agent.scaleRefusalFor(proposal, threadId).catch(() => null)) ??
        (await agent.imageRefusalFor(proposal, threadId, rca).catch(() => null));
      if (refusal) {
        proposalRaw = `${proposalRaw}\n[guard refused] ${refusal}`;
        proposal = null;
      }
    }
    return {
      score: combine(scoreProposal(task.expect, proposal, proposalRaw), scoreGrounding(ungrounded), scoreRca(task.expect.rca, rca)),
      rca,
      proposal,
      proposalRaw,
      ungrounded,
    };
  } catch (err) {
    // A crashed attempt is a failed attempt, not a crashed run: the other tasks still have
    // something to say, and hiding this one behind an exception would inflate every rate.
    const msg = err instanceof Error ? err.message : String(err);
    return { score: { pass: false, reasons: [`attempt threw: ${msg}`] }, rca: "", proposal: null, proposalRaw: "", ungrounded: [] };
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
      let proposalRaw = "";
      let ungrounded: string[] = [];
      try {
        // A setup that fails is a failed ATTEMPT, not a failed run — same reasoning as the
        // catch inside attempt(). It also must not skip cleanup: the first live run of this
        // harness hit a fault injector that could not fire, and the crash left its namespace
        // behind on the cluster.
        await waitForIsolation();
        await resetIncidentMemory();
        hook(task, "setup.sh");
        if (task.settleSeconds) await sleep(task.settleSeconds * 1000);
        ({ score, rca, proposal, proposalRaw, ungrounded } = await attempt(agent, llm, task, n));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        score = { pass: false, reasons: [`setup failed, so the fault was never injected: ${msg}`] };
      } finally {
        hook(task, "cleanup.sh");
      }
      logger.info(`[bench] ${task.id} attempt ${n}: ${score.pass ? "PASS" : `FAIL — ${score.reasons.join("; ")}`}`);
      scores.push(score);
      detail.push({ task: task.id, attempt: n, pass: score.pass, axes: score.axes, reasons: score.reasons, ungrounded, proposal, proposalRaw, rca });
    }
    runs.push({ task: task.id, attempts: scores });
  }

  const rates = passRates(runs);
  const axes = axisTally(runs);
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
  // Which axis moved. With one number and two axes, a drop tells you the agent got worse and
  // nothing about where to look.
  const all = runs.flatMap((r) => r.attempts);
  const axisNames = [...new Set(all.flatMap((a) => Object.keys(a.axes ?? {})))].sort();
  if (axisNames.length > 0) {
    const tally = axisNames
      .map((ax) => {
        const seen = all.filter((a) => a.axes && ax in a.axes);
        return `${ax} ${seen.filter((a) => a.axes![ax]).length}/${seen.length}`;
      })
      .join("   ");
    console.log(`axes: ${tally}`);
  }
  if (rates.k > 1) console.log("pass^k is the one that matters: an agent right four times in five is one whose output must be checked every time.\n");

  // The registry, not the env: this records what the router actually resolved.
  const meta = runMeta(
    config.llm.provider === "router" ? parseRegistry(process.env).backends : [{ name: config.llm.provider }]
  );

  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ meta, rates, axes, runs, detail }, null, 2));
  console.log(`full transcript: ${out}`);

  // The one file in bench/results/ that is NOT gitignored, and the only place a score outlives
  // this machine. Committed and pushed straight away unless --no-push: a score that needs a
  // second manual step is a score that stops being recorded the first busy week.
  const history = join(RESULTS_DIR, "history.jsonl");
  // A FILTERED run is a spot check, not a score. `--filter '^A08'` measures one case against one
  // fix, and its pass@1 is not comparable to a suite's. Measured back when that was handled by
  // not writing the line at all: 16 lines, 3 of them whole-suite runs — the page showed 20
  // newest and was 80% spot checks, with the only three comparable numbers buried among them.
  //
  // Dropping the line fixed the burial and lost the attempts with it: B04 and C08 were measured
  // six times on 2026-09-24 and the per-case table, which has no comparability problem, never
  // saw them. The line is written either way now and carries `filter`, and the dashboard decides
  // per view — out of the run list and the leaderboard, into the per-case rates. `--no-push`
  // still means "keep nothing", for either kind.
  if (has("no-push")) {
    // Skips the APPEND too, not just the push. The only reason to pass this is that the run is
    // not one you want kept — a dry run with a deliberately unusable key, a half-finished case.
    // Recording it and leaving it uncommitted just moves the cleanup to whoever commits next,
    // which is how a 0% from a bad API key ended up in this file's own history.
    console.log("--no-push: this run was not recorded");
  } else {
    appendHistory(history, { meta, rates, axes, runs, filter: filterArg ?? null });
    console.log(`history line appended: ${history}`);
    publishHistory(history);
  }

  // Non-zero on any inconsistency, so this can gate CI without a second script deciding what
  // "good" means. pass^k, not pass@k — see above.
  process.exit(rates.passHatK === 1 ? 0 : 1);
}

main().catch((err) => {
  logger.error(`[bench] ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
