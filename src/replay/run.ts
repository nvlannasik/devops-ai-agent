import { DevOpsAgent } from "../agent/index.js";
import { TraceRecorder } from "../agent/trace/index.js";
import type { EventRow } from "../agent/trace/store.js";
import type { LLMClient } from "../agent/llm/types.js";
import type { RemediationStore } from "../agent/remediation/index.js";
import { config } from "../config/index.js";
import { withTrace } from "../utils/trace/index.js";
import { Diverged, ReplayLLM, ReplayMCP, type Mode, type Phase } from "./fakes.js";
import type { Expect, Trace } from "./trace.js";

export interface ReplayResult {
  outcome: "completed" | "diverged" | "crashed";
  answer: string;
  /** The replay's own gate decisions, `name:outcome`, in order — delegates' included. */
  gates: string[];
  /** undefined: the trace had no proposal run. */
  /** `dryRun: "unrecorded"`: a live proposal passed every agent-side gate and reached a dry-run the
   *  recording cannot answer — the MCP server's own validation is not something replay may invent. */
  proposal?: { action: string; dryRun?: "unrecorded" } | { refused: string } | null;
  where?: string;
}

// Every card is accepted: without a database `propose()` returns null, and a proposal that passed
// every gate would replay as "no proposal" (the same reason AgentDeps.remediations exists).
const unrecordedDryRun = (refused: string): { action: string; dryRun: "unrecorded" } | null => {
  const m = /^not recorded in this trace \(([\w-]+)\)$/.exec(refused);
  return m ? { action: m[1]!, dryRun: "unrecorded" } : null;
};

const ACCEPT_ALL = { pendingFor: async () => null, propose: async () => 1 } as unknown as RemediationStore;

/**
 * Plays one recorded run back through a real DevOpsAgent (spec §7). `gates`: the model's answers
 * and the tool results both come from the trace, so what is being tested is the code between them —
 * deterministic and free. `tools`: the model is live and the cluster is the recording.
 *
 * ponytail: a run starts from an empty thread. A follow-up mention's earlier turns are not
 * restored into memory, so a gate that reads the thread's history (the follow-up marker, the
 * offer parser) can decide differently than it did live. Restore prior runs' answers if a case
 * ever needs it.
 */
export async function replay(trace: Trace, opts: { mode: Mode; live?: LLMClient; livePhases?: Phase[] }): Promise<ReplayResult> {
  const start = trace.events.find((e) => e.kind === "start" && e.thread_ts === trace.thread && e.payload.phase === "investigate");
  if (!start) throw new Error("trace has no investigation start");
  const proposalStart = trace.events.find((e) => e.kind === "start" && e.thread_ts === trace.thread && e.payload.phase === "proposal");

  const rows: EventRow[] = [];
  const recorder = new TraceRecorder({ insert: async (r) => void rows.push(...r) }, { source: "replay", sha: "replay" });
  const llm = new ReplayLLM(trace, opts.mode === "tools" ? (opts.live ?? null) : null, opts.livePhases ?? null);
  const mcp = new ReplayMCP(trace, opts.mode);
  const agent = new DevOpsAgent({ llm, mcp: mcp as never, recorder, remediations: ACCEPT_ALL });

  // A delegate's budget comes from config, and local config is not production's. The recorded
  // sub-run start says what production gave it.
  const sub = trace.events.find((e) => e.kind === "start" && e.thread_ts.includes("/sub-"))?.payload.opts;
  const budgets = config.subagents as { toolRounds: number; maxIterations: number };
  const saved = { toolRounds: budgets.toolRounds, maxIterations: budgets.maxIterations };
  if (sub?.maxToolRounds) budgets.toolRounds = sub.maxToolRounds;
  if (sub?.maxIterations) budgets.maxIterations = sub.maxIterations;

  const o = start.payload.opts ?? {};
  let answer = "";
  let proposal: ReplayResult["proposal"];
  const gates = () => rows.filter((r) => r.kind === "gate").map((r) => `${r.name}:${r.outcome}`);
  try {
    answer = await agent.investigate(trace.thread, start.payload.issue, {
      mode: o.mode,
      trigger: o.trigger ?? undefined,
      namespace: o.namespace ?? undefined,
      maxToolRounds: o.maxToolRounds ?? undefined,
      maxIterations: o.maxIterations ?? undefined,
    });
    if (proposalStart) {
      llm.phase = mcp.phase = "proposal";
      const p = proposalStart.payload;
      const out = await withTrace(trace.thread, () =>
        agent.proposeRemediation(1, p.labels ?? {}, p.issue, { userRequested: p.opts?.userRequested, offer: p.opts?.offer ?? null, threadId: trace.thread })
      );
      proposal = out === null ? null : "refused" in out ? (unrecordedDryRun(out.refused) ?? { refused: out.refused }) : { action: out.proposal.action };
    }
  } catch (err) {
    const where = llm.divergedAt ?? mcp.divergedAt;
    if (where || err instanceof Diverged) return { outcome: "diverged", answer, gates: gates(), proposal, where: where ?? (err as Error).message };
    return { outcome: "crashed", answer, gates: gates(), proposal, where: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  } finally {
    Object.assign(budgets, saved);
  }
  const where = llm.divergedAt ?? mcp.divergedAt;
  if (where) return { outcome: "diverged", answer, gates: gates(), proposal, where };
  return { outcome: "completed", answer, gates: gates(), proposal };
}

/** A replay against its case's expectations (spec §8.1). */
export function score(r: ReplayResult, e: Expect): { outcome: "passed" | "failed" | "diverged" | "crashed"; why: string[] } {
  if (r.outcome === "crashed") return { outcome: "crashed", why: [r.where ?? ""] };
  if (r.outcome === "diverged") return e.allowDiverge ? { outcome: "passed", why: [] } : { outcome: "diverged", why: [r.where ?? ""] };
  const why: string[] = [];
  for (const p of e.answer?.must ?? []) if (!new RegExp(p, "i").test(r.answer)) why.push(`answer lacks /${p}/`);
  for (const p of e.answer?.mustNot ?? []) if (new RegExp(p, "i").test(r.answer)) why.push(`answer has /${p}/`);
  for (const g of e.gates?.must ?? []) if (!r.gates.includes(g)) why.push(`gate ${g} did not fire`);
  for (const g of e.gates?.mustNot ?? []) if (r.gates.includes(g)) why.push(`gate ${g} fired`);
  if (e.proposal) {
    const got = r.proposal && "action" in r.proposal ? r.proposal.action : null;
    if (got !== e.proposal.action) why.push(`proposal ${got ?? "none"}, expected ${e.proposal.action ?? "none"}`);
  }
  return { outcome: why.length > 0 ? "failed" : "passed", why };
}
