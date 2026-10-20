import type { LLMResponse, TokenUsage, ToolDefinition } from "../llm/types.js";
import type { selectForThread } from "../skills/thread.js";
import type { RunMode } from "./control.js";

// What one investigation carries from round to round (2026-10-21 split of runInvestigation). The
// options and the footer's metadata are the run's inputs and outputs; RunState is everything the
// loop mutates, in one object so the gates in answer-gates.ts and the finalizer can read the
// same values the loop does at the moment they run — never a copy taken earlier.

export interface InvestigateOptions {
  maxToolRounds?: number;
  trigger?: string;
  /** Defaults to "alert" — the strictest of the three, so an unconverted caller loses nothing. */
  mode?: RunMode;
  /** Defaults to MAX_ITERATIONS. */
  maxIterations?: number;
  /** Absolute epoch ms. Defaults to now + config.investigationTimeoutMs. */
  deadline?: number;
  /** 0 = the lead investigation, 1 = a delegate. Only depth 0 is offered the delegate tool. */
  depth?: number;
  /**
   * The namespace the alert labels name, quoted back in the placeholder refusal.
   * Telling the model to "use the real namespace" was not enough — on 2026-09-22 it answered the
   * alert by asking the human which namespace to use. Naming it leaves nothing to ask.
   */
  namespace?: string;
  /**
   * Called once per tool round, before the tools run, with the round number and the tool
   * names that round will actually execute. Optional and fire-and-forget: the loop ignores
   * whatever it returns and never awaits it, because a progress update is not worth failing
   * an investigation over.
   *
   * It exists for perceived latency, not real latency. One round against a slow backend is
   * tens of seconds of nothing, and an alert thread that sits on a single static notice for
   * minutes is indistinguishable from an agent that has crashed — which is what an on-call
   * reader assumes. Only the alert path passes it; a delegate has no Slack message to update.
   */
  onProgress?: (round: number, tools: string[]) => void;
  /**
   * Run metadata for the Slack footer, delivered as a sink rather than a return value.
   * investigate() returns the reply text and a dozen call sites depend on that; a sink also
   * stays correct under INVESTIGATION_MAX_CONCURRENT, where a `lastRunMeta()` getter would
   * hand one thread another thread's numbers.
   */
  onComplete?: (meta: RunMeta) => void;
}

/** What the Slack footer reports. Every field is measured, never estimated. */
export interface RunMeta {
  durationMs: number;
  /** LLM calls, not tool rounds — the number that explains the latency. */
  rounds: number;
  toolCalls: number;
  /** From the LAST response: on a failover it is the backend that actually answered. */
  backend?: string;
  model?: string;
  route?: "light" | "heavy";
}

export const zeroUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

export const addUsage = (acc: TokenUsage, u: TokenUsage): TokenUsage => ({
  inputTokens: acc.inputTokens + u.inputTokens,
  outputTokens: acc.outputTokens + u.outputTokens,
  cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
  cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
});

export interface RunState {
  iterations: number;
  toolRounds: number;
  totalToolCalls: number;
  toolsDisabled: boolean;
  /** Set by the first tool round (conversation mode). */
  scopeNamespaces: Set<string> | null;
  /** Any log tool returned content — see LOG_GAP_NOTICE. */
  sawLogLines: boolean;
  /** The nudge is spent once per investigation, never a loop. */
  logGapNudged: boolean;
  /** Same, for IMAGE_GAP_NOTICE — one hold slot serves every gate. */
  imageGapNudged: boolean;
  /** Same, for NO_EVIDENCE_NOTICE. */
  noEvidenceNudged: boolean;
  /** Same, for an RCA that stopped before the template did. */
  rcaGapNudged: boolean;
  /**
   * WHICH gate is holding an answer, not merely that one is. The log-gap restore test reads
   * "the extra round ran no tools" as failure, which is true of a nudge that asked for a fetch
   * and false of the RCA-completeness one, whose whole request is a tool-free rewrite.
   */
  heldBy: "tools" | "rca" | null;
  /**
   * The answer the nudge interrupted, and the round count when it did. Kept so a nudge that
   * produces no new evidence cannot downgrade an answer that was already complete.
   */
  preNudgeSummary: string;
  toolRoundsAtNudge: number;
  totalUsage: TokenUsage;
  /**
   * The response that ANSWERED, not the first one tried: on a failover the backend that
   * finally worked is the one the footer must name.
   */
  lastResponse: LLMResponse | undefined;
  skills: ReturnType<typeof selectForThread>;
}

/** The run's fixed facts, computed once before the loop. */
export interface RunCtx {
  threadId: string;
  mode: RunMode;
  depth: number;
  maxToolRounds: number;
  maxIterations: number;
  deadline: number;
  startedAt: number;
  tools: ToolDefinition[];
  systemPrompt: string;
  opts: InvestigateOptions;
}

export const newRunState = (skills: RunState["skills"]): RunState => ({
  iterations: 0,
  toolRounds: 0,
  totalToolCalls: 0,
  toolsDisabled: false,
  scopeNamespaces: null,
  sawLogLines: false,
  logGapNudged: false,
  imageGapNudged: false,
  noEvidenceNudged: false,
  rcaGapNudged: false,
  heldBy: null,
  preNudgeSummary: "",
  toolRoundsAtNudge: -1,
  totalUsage: zeroUsage(),
  lastResponse: undefined,
  skills,
});
