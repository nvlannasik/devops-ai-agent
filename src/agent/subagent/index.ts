import type { ContentBlock, ToolDefinition } from "../llm/types.js";

/**
 * Sub-agent delegation: the lead investigation hands one hypothesis to a child that runs the
 * same loop in its own context and returns findings.
 *
 * Off unless SUBAGENT_ENABLED=true, and "off" means the tool is never registered — not
 * registered-and-refused. The tools array is cached as a single block (llm/claude.ts marks the
 * last tool ephemeral) and counts against the context budget, so a tool that is present but
 * unusable would leave the flag's OFF side something other than the behaviour it exists to be
 * the baseline for.
 */
export const DELEGATE_TOOL = "delegate_investigation";

export interface SubagentConfig {
  readonly enabled: boolean;
  readonly maxFanout: number;
  readonly toolRounds: number;
  readonly maxIterations: number;
}

/**
 * Taken off the parent's deadline to get the child's. The parent still has to read what the
 * delegates found and compose an answer; a child running to the parent's own deadline delivers
 * its evidence to a run that has already given up on it.
 */
export const CHILD_DEADLINE_RESERVE_MS = 60_000;

export const childDeadline = (parentDeadline: number): number =>
  parentDeadline - CHILD_DEADLINE_RESERVE_MS;

/**
 * Prefixed with the parent's id, so grepping the Slack thread id still finds every child across
 * the agent log, the llm-worker log and the thread itself — the property utils/trace exists for.
 */
export const subThreadId = (threadId: string, n: number): string => `${threadId}/sub-${n}`;

/**
 * A delegate is a new entry point, and every entry point stamps its own response-mode marker
 * (MEMORY_BANK.md §Response Mode): without one the model defaults to the full RCA format, which
 * is the wrong shape for something whose reader is the lead investigation rather than a human.
 *
 * Self-describing on purpose. The alternative — a clause in prompts/system.md — would edit the
 * one static cached block that the flag's OFF side shares, so OFF would no longer be today's
 * behaviour byte for byte.
 */
export const DELEGATE_MARKER =
  "[DELEGATED SUB-INVESTIGATION — you are one of several investigators working a single incident " +
  "in parallel. Investigate ONLY the hypothesis below; the lead investigation covers everything " +
  "else. Do NOT use the RCA incident format — your reader is the lead investigation, not a human " +
  "in Slack. Open with SUPPORTED, CONTRADICTED or UNPROVEN, then the evidence behind that verdict. " +
  "Every claim names the tool that produced it and quotes the line it rests on. A negative result " +
  'is still a result: "no OOMKilled events in the last hour" is worth reporting.]';

export function delegateTool(cfg: SubagentConfig): ToolDefinition {
  return {
    name: DELEGATE_TOOL,
    description:
      "Investigate ONE hypothesis in a separate context and return its findings. Use this only " +
      "when the incident has several genuinely different candidate causes that each need their own " +
      'multi-step investigation ("the 14:02 rollout regressed it", "the node is out of memory", ' +
      '"an upstream dependency is failing"). Issue them in the SAME turn — up to ' +
      `${cfg.maxFanout} run in parallel. To fetch one piece of data, call the data tool directly; ` +
      "this is not a shortcut for that. State the hypothesis as a claim to test rather than a topic, " +
      "and name the namespace and workload: the delegate starts from an empty context and sees " +
      "nothing of this thread. It cannot delegate further. It returns prose whose claims cite the " +
      "tool behind them — a claim that cites nothing is unverified, so say so rather than repeating " +
      "it as fact.",
    inputSchema: {
      type: "object",
      properties: {
        hypothesis: {
          type: "string",
          description:
            "The claim to test, with the namespace and workload named. Example: \"the 5xx spike in " +
            'namespace `payments` began with the 14:02 rollout of deployment `api-gateway`".',
        },
      },
      required: ["hypothesis"],
    },
  };
}

/**
 * ponytail: the child inherits the parent's whole tool set (minus this one). Letting the model
 * name a subset per delegate is the stronger scope guard — a log-reader that physically cannot
 * reach Prometheus beats one that is told not to — but it adds a second thing the model can get
 * wrong (invalid names, a delegate narrowed into blindness). Add it when a delegate is observed
 * wandering; the finite toolRounds budget already engages the namespace scope lock meanwhile.
 */
/**
 * `run` is the shape of the investigation asking for the tool, not two loose numbers: `depth`
 * and `maxToolRounds` are both numeric and swapping them silently offers the tool to exactly the
 * runs it must be kept from.
 */
export interface RunShape {
  /** 0 = the lead investigation, 1 = a delegate. */
  depth: number;
  /** Infinity on the alert path and on an explicit investigation request; finite otherwise. */
  maxToolRounds: number;
}

export function withDelegateTool(
  tools: ToolDefinition[],
  cfg: SubagentConfig,
  run: RunShape
): ToolDefinition[] {
  if (!cfg.enabled || !offersDelegation(run)) return tools;
  return [...tools, delegateTool(cfg)];
}

/**
 * Who is offered delegation, and the tool-budget half is the part worth explaining.
 *
 * A finite budget means conversation mode: `MENTION_TOOL_ROUNDS` is 2, so one delegate spends
 * half the rounds the whole question gets, and takes CHILD_DEADLINE_RESERVE_MS off the parent's
 * clock to do it. A delegate cannot pay for itself out of that. An infinite budget is exactly the
 * set worth delegating from — the alert path, and a mention `wantsInvestigation()` recognised as
 * an explicit investigation request — because those are the runs that produce an RCA over several
 * competing causes, which is the only thing delegation is for.
 *
 * The depth half is the nesting policy: a delegate is never offered the tool, and it also runs
 * with a finite `SUBAGENT_TOOL_ROUNDS`, so either clause alone would stop it. Both are stated
 * because they answer different questions and neither should depend on the other holding.
 */
export const offersDelegation = (run: RunShape): boolean =>
  run.depth === 0 && run.maxToolRounds === Infinity;

/**
 * Same shape as the log fan-out guard in the loop: the calls past the cap are refused with
 * synthesized tool_results rather than dropped, because an unanswered tool_use is a 400 from
 * Anthropic, not a smaller request.
 */
export function capFanout(
  calls: ContentBlock[],
  maxFanout: number
): { run: ContentBlock[]; refusals: ContentBlock[] } {
  return {
    run: calls.slice(0, maxFanout),
    refusals: calls.slice(maxFanout).map((c) => ({
      type: "tool_result" as const,
      tool_use_id: c.id,
      content:
        `Error: at most ${maxFanout} hypotheses may be delegated per turn and this turn is already ` +
        "at that limit — this one did not run. Fold it into your own investigation, or drop it.",
    })),
  };
}

export const hypothesisOf = (call: ContentBlock): string =>
  String((call.input as Record<string, unknown> | undefined)?.hypothesis ?? "").trim();

/**
 * The deterministic half of delegation.
 *
 * The model was given the tool, an unlimited budget and a 342-token prompt section, and across
 * three firing incidents it never once reached for it — including one with 388k characters of
 * logs and two related alerts. That is the same finding MEMORY_BANK records for every other
 * behaviour in this loop: a rule the model has to remember does not hold, a marker on the message
 * does. So the loop names the condition instead of hoping the model recognises it.
 *
 * The condition is not a heuristic: it is read straight off the alert labels before the first LLM
 * call. One rule firing for two different services IS two candidate causes, and which of the two
 * readings is right — one cascade, or two unrelated problems — is the question the investigation
 * exists to answer. Nothing in the payload settles it, and the current code assumed the first
 * reading silently (`correlation/index.ts`'s "every alert in the payload shares a root cause").
 *
 * Returns "" whenever delegation is not on the table, so the alert message is untouched with the
 * flag off — same rule as the tool and the prompt section.
 */
export function delegationHint(
  subjects: { key: string; values: string[] } | null,
  cfg: SubagentConfig
): string {
  if (!cfg.enabled || !subjects || subjects.values.length < 2) return "";
  const named = subjects.values.slice(0, cfg.maxFanout);
  const list = named.map((v) => `\`${v}\``).join(", ");
  const spare = subjects.values.length - named.length;

  return (
    `\n[MULTI-SUBJECT ALERT GROUP — one rule fired for ${subjects.values.length} different ` +
    `${subjects.key}s: ${list}${spare > 0 ? ` and ${spare} more` : ""}. They may share one root ` +
    `cause or be separate problems that tripped the same threshold, and deciding which is this ` +
    `investigation's job — do not assume either. Issue one \`delegate_investigation\` per ` +
    `${subjects.key} in your FIRST turn (${named.length}, in parallel), each testing whether that ` +
    `${subjects.key}'s failure originates in itself or arrives from something it depends on. Then ` +
    `state in your RCA whether this is one cascade or separate incidents, and name the evidence ` +
    `that decided it. If \`delegate_investigation\` is not in your tool list, investigate them ` +
    `yourself and answer that same question.]`
  );
}
