import type { LLMClient, LLMResponse, ToolDefinition } from "../agent/llm/types.js";
import { toolCallKey } from "../agent/index.js";
import { currentTrace } from "../utils/trace/index.js";
import type { Trace } from "./trace.js";

export type Phase = "investigate" | "proposal";
export type Mode = "gates" | "tools";

/** The replayed harness asked for something the recording does not have — the signal, not a bug. */
export class Diverged extends Error {
  constructor(readonly where: string) {
    super(`diverged: ${where}`);
    this.name = "Diverged";
  }
}

/** run id → phase, read from each run's start event. */
const phases = (trace: Trace): Map<string, Phase> =>
  new Map(trace.events.filter((e) => e.kind === "start").map((e) => [e.payload.run, e.payload.phase === "proposal" ? "proposal" : "investigate"]));

/**
 * The model, played back. One queue per thread and phase: delegates run in parallel under their
 * own `<thread>/sub-N` trace id, and the proposal's light-route call lives on the parent thread
 * after its investigation ended, so neither can be told apart by order alone.
 */
export class ReplayLLM implements LLMClient {
  phase: Phase = "investigate";
  divergedAt: string | null = null;
  private readonly queues = new Map<string, LLMResponse[]>();
  private readonly served = new Map<string, number>();

  /**
   * `live` answers every call, or only the calls of `livePhases` — the rest still come from the
   * recording. Live for the proposal alone compares proposal models on the identical investigation.
   */
  constructor(
    trace: Trace,
    private readonly live: LLMClient | null = null,
    private readonly livePhases: readonly Phase[] | null = null
  ) {
    const phaseOf = phases(trace);
    for (const e of trace.events) {
      if (e.kind !== "llm") continue;
      const k = `${phaseOf.get(e.payload.run) ?? "investigate"}|${e.thread_ts}`;
      this.queues.set(k, [...(this.queues.get(k) ?? []), { content: e.payload.content, stopReason: e.payload.stopReason, usage: e.payload.usage ?? undefined }]);
    }
  }

  async chat(...args: Parameters<LLMClient["chat"]>): Promise<LLMResponse> {
    if (this.live && (!this.livePhases || this.livePhases.includes(this.phase))) return this.live.chat(...args);
    const thread = currentTrace() ?? "";
    const k = `${this.phase}|${thread}`;
    const n = this.served.get(k) ?? 0;
    this.served.set(k, n + 1);
    const recorded = this.queues.get(k)?.[n];
    if (!recorded) {
      this.divergedAt ??= `LLM #${n + 1} on ${thread} (${this.phase}) — the trace has ${this.queues.get(k)?.length ?? 0}`;
      throw new Diverged(this.divergedAt);
    }
    return recorded;
  }
}

/**
 * The cluster, played back. Results are matched by thread, phase and `toolCallKey` — the agent's
 * own memo key, which ignores time-window parameters — and served in recorded order, the last one
 * repeating: a guard may read the same pod list twice. An unrecorded call is NOT thrown: the loop
 * turns a tool exception into an error result and carries on, which would hide it. It is marked,
 * and the runner reports the run as diverged.
 */
export class ReplayMCP {
  phase: Phase = "investigate";
  divergedAt: string | null = null;
  private readonly tools: ToolDefinition[];
  private readonly results = new Map<string, Array<{ result?: string; error?: string }>>();
  private readonly served = new Map<string, number>();

  constructor(trace: Trace, private readonly mode: Mode) {
    const phaseOf = phases(trace);
    const start = trace.events.find((e) => e.kind === "start" && e.thread_ts === trace.thread && e.payload.phase !== "proposal");
    this.tools = (start?.payload.tools ?? []) as ToolDefinition[];
    for (const e of trace.events) {
      if (e.kind !== "tool") continue;
      const k = `${phaseOf.get(e.payload.run) ?? "investigate"}|${e.thread_ts}|${toolCallKey(e.name ?? "", e.payload.input)}`;
      this.results.set(k, [...(this.results.get(k) ?? []), { result: e.payload.result, error: e.payload.error }]);
    }
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    const thread = currentTrace() ?? "";
    const k = `${this.phase}|${thread}|${toolCallKey(name, input)}`;
    const recorded = this.results.get(k);
    if (!recorded?.length) {
      if (this.mode === "gates") this.divergedAt ??= `tool ${name} ${JSON.stringify(input)} on ${thread} (${this.phase}) was never recorded`;
      return `Error: not recorded in this trace (${name})`;
    }
    const i = Math.min(this.served.get(k) ?? 0, recorded.length - 1);
    this.served.set(k, i + 1);
    const r = recorded[i]!;
    if (r.error !== undefined) throw new Error(r.error);
    return r.result ?? "";
  }
}
