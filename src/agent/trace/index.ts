import { randomUUID } from "node:crypto";
import type { LLMClient, LLMResponse } from "../llm/types.js";
import { stripLoneSurrogates } from "../llm/sanitize.js";
import { currentTrace } from "../../utils/trace/index.js";
import logger, { errDetail } from "../../utils/logger/index.js";
import type { EventRow } from "./store.js";

/**
 * Every gate the dashboard knows. A closed list, so a typo is a compile error and the Harness
 * page's rows are exactly this list (spec docs/superpowers/specs/2026-10-01-harness-trace-design.md §5).
 */
export const GATE_NAMES = [
  "no-evidence", "log-gap", "image-gap", "rca-completeness", "nudge-lost-rca",
  "tool-budget", "iteration-ceiling", "deadline", "delegate",
  "placeholder", "injection", "repeat-call", "log-fanout", "scope-lock", "write-blocked",
  "confidence-cap", "template-echo", "fabricated-note", "runbook", "offer",
  "grounding", "rca-structure",
  "remediation-replacement", "remediation-quarantine", "remediation-orphan", "remediation-offer",
  "remediation-target", "remediation-resource-fault", "remediation-scale", "remediation-image",
  "remediation-other", "dry-run", "proposal",
] as const;
export type GateName = (typeof GATE_NAMES)[number];
export type NudgeResolution = "accepted" | "restored" | "kept-earlier";

/** refusalFor's gate strings ("image gate", "replacement guard") as gate names. */
export const refusalGate = (gate: string): GateName => {
  const name = `remediation-${gate.replace(/ (gate|guard)$/, "").replace(/\s+/g, "-")}`;
  return (GATE_NAMES as readonly string[]).includes(name) ? (name as GateName) : "remediation-other";
};

/** One tool result's cap, in characters (spec §4.3). The agent compacts far below this anyway. */
export const MAX_RESULT_CHARS = 512 * 1024;
/** Open runs held at once. A run is closed by finish() in a finally; this only bounds a leak. */
const MAX_OPEN_RUNS = 200;

export interface Sink {
  insert(rows: EventRow[]): Promise<void>;
}

interface Run {
  id: string;
  events: EventRow[];
  skills: string[];
  pendingNudge: GateName | null;
}

// Postgres jsonb refuses \u0000 and a lone surrogate, and either one fails the WHOLE batch.
const cleanDeep = (v: unknown): unknown => {
  if (typeof v === "string") return stripLoneSurrogates(v.replaceAll("\u0000", ""));
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)]));
  return v;
};

/**
 * Records investigation runs into agent_events. A run is everything between begin() and
 * finish() for one thread id — delegates are their own runs under `<thread>/sub-N`. Events are
 * buffered and written in one batch by finish(), so the hot path pays one array push per event.
 * Nothing here throws into the caller: a lost trace is a warn, never a failed investigation.
 */
export class TraceRecorder {
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly sink: Sink | null,
    private readonly opts: { source: "prod" | "bench" | "replay"; sha: string }
  ) {}

  get enabled(): boolean {
    return this.sink !== null;
  }

  begin(threadTs: string, start: Record<string, unknown>): void {
    if (!this.sink) return;
    // A previous run on this thread that never finished is flushed rather than merged: two runs
    // under one id would replay as one.
    if (this.runs.has(threadTs)) void this.finish(threadTs);
    while (this.runs.size >= MAX_OPEN_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      void this.finish(oldest);
    }
    const run: Run = { id: randomUUID(), events: [], skills: [], pendingNudge: null };
    this.runs.set(threadTs, run);
    this.push(threadTs, run, "start", null, null, { ...start, source: this.opts.source, sha: this.opts.sha });
  }

  /** The playbooks the NEXT llm() call carries — set by the loop right before chat(). */
  skills(threadTs: string, names: string[]): void {
    const run = this.runs.get(threadTs);
    if (run) run.skills = names;
  }

  llm(threadTs: string, response: LLMResponse): void {
    const run = this.runs.get(threadTs);
    if (!run) return;
    this.push(threadTs, run, "llm", response.backend ?? null, null, {
      content: response.content,
      stopReason: response.stopReason,
      usage: response.usage ?? null,
      route: response.route ?? null,
      model: response.model ?? null,
      skills: run.skills,
    });
  }

  tool(threadTs: string, name: string, input: unknown, outcome: { result: string } | { error: string }, ms: number): void {
    const run = this.runs.get(threadTs);
    if (!run) return;
    if ("error" in outcome) {
      this.push(threadTs, run, "tool", name, null, { input, error: outcome.error, ms });
      return;
    }
    const truncated = outcome.result.length > MAX_RESULT_CHARS;
    this.push(threadTs, run, "tool", name, null, {
      input,
      result: truncated ? outcome.result.slice(0, MAX_RESULT_CHARS) : outcome.result,
      truncated,
      ms,
    });
  }

  gate(threadTs: string, name: GateName, outcome: string, detail = "", extra: Record<string, unknown> = {}): void {
    if (!this.sink) return;
    const payload = { ...extra, detail: detail.slice(0, 500), source: this.opts.source };
    const run = this.runs.get(threadTs);
    if (!run) {
      // After the run was flushed (the app posts the RCA later): a row of its own, no run id.
      const row: EventRow = { threadTs, seq: 0, kind: "gate", name, outcome, payload: cleanDeep({ ...payload, run: null }) as Record<string, unknown> };
      void this.sink.insert([row]).catch((err) => logger.warn(`[trace] gate ${name} for ${threadTs} not written: ${errDetail(err)}`));
      return;
    }
    if (outcome === "nudge") {
      // The retry of the first nudge is the answer the second one interrupted — it was used.
      if (run.pendingNudge) this.push(threadTs, run, "gate", run.pendingNudge, "accepted", { detail: "", source: this.opts.source });
      run.pendingNudge = name;
    }
    this.push(threadTs, run, "gate", name, outcome, payload);
  }

  resolveNudge(threadTs: string, resolution: NudgeResolution): void {
    const run = this.runs.get(threadTs);
    if (!run?.pendingNudge) return;
    this.push(threadTs, run, "gate", run.pendingNudge, resolution, { detail: "", source: this.opts.source });
    run.pendingNudge = null;
  }

  end(threadTs: string, payload: Record<string, unknown>): void {
    const run = this.runs.get(threadTs);
    if (!run) return;
    this.resolveNudge(threadTs, "accepted");
    this.push(threadTs, run, "end", null, null, payload);
  }

  async finish(threadTs: string): Promise<void> {
    const run = this.runs.get(threadTs);
    if (!run || !this.sink) return;
    this.runs.delete(threadTs);
    if (run.pendingNudge) this.push(threadTs, run, "gate", run.pendingNudge, "accepted", { detail: "", source: this.opts.source });
    try {
      await this.sink.insert(run.events);
    } catch (err) {
      logger.warn(`[trace] run ${run.id} for ${threadTs} not written: ${errDetail(err)}`);
    }
  }

  private push(threadTs: string, run: Run, kind: EventRow["kind"], name: string | null, outcome: string | null, payload: Record<string, unknown>): void {
    run.events.push({
      threadTs,
      seq: run.events.length,
      kind,
      name,
      outcome,
      payload: cleanDeep({ ...payload, run: run.id }) as Record<string, unknown>,
    });
  }
}

/**
 * Every chat() call, from every call site, under the ambient trace id. Wrapping the client once
 * is what keeps the call sites untouched — there are five of them and more will come.
 */
export function instrumentLLM(llm: LLMClient, rec: () => TraceRecorder): LLMClient {
  return {
    chat: async (messages, tools, systemPrompt) => {
      const response = await llm.chat(messages, tools, systemPrompt);
      const t = currentTrace();
      if (t) rec().llm(t, response);
      return response;
    },
    shutdown: llm.shutdown?.bind(llm),
  };
}

/** Same for MCP: the RAW result, before the injection guard and compaction see it. */
export function instrumentMCP<T extends { callTool(name: string, input: Record<string, unknown>): Promise<string> }>(
  mcp: T,
  rec: () => TraceRecorder
): T {
  const call = mcp.callTool.bind(mcp);
  mcp.callTool = async (name: string, input: Record<string, unknown>) => {
    const t = currentTrace();
    const start = Date.now();
    try {
      const result = await call(name, input);
      if (t) rec().tool(t, name, input, { result }, Date.now() - start);
      return result;
    } catch (err) {
      if (t) rec().tool(t, name, input, { error: errDetail(err) }, Date.now() - start);
      throw err;
    }
  };
  return mcp;
}
