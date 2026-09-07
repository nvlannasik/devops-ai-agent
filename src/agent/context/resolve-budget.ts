import type { Registry, BackendSpec, BackendKind } from "../llm/registry.js";
import { BUDGET_SAFETY_MARGIN, DEFAULT_CONTEXT_TOKENS, type Budget } from "./budget.js";

// DEFAULT_CONTEXT_TOKENS is total over BackendKind, so this only falls through to the second `??`
// when resolveBudget's no-registry branch casts an arbitrary provider string to BackendKind. The
// fallback is the smallest default on purpose: an unrecognised provider gets the conservative
// window rather than a 200k assumption that fails at request time.
export const windowOf = (spec: BackendSpec): number =>
  spec.contextTokens ?? DEFAULT_CONTEXT_TOKENS[spec.kind] ?? DEFAULT_CONTEXT_TOKENS["private-llm"];

// The output ceiling this backend may actually emit. Per-backend when declared; the global
// MAX_TOKENS otherwise. For private-llm the agent sends no ceiling at all — llm-worker holds
// its own LLM_MAX_TOKENS — so the spec value is a declaration of that worker's setting, and
// the ONLY way this process can know how much window to keep clear for the answer.
export const outputOf = (spec: BackendSpec, fallback: number): number => spec.maxTokens ?? fallback;

/**
 * One budget for the whole process, resolved at boot.
 *
 * The router picks a backend AFTER the request has been built, so a request must survive
 * whichever one it lands in — and the two halves of that are conservative in OPPOSITE
 * directions:
 *
 *   window  -> the SMALLEST, because the request has to fit inside it.
 *   reserve -> the LARGEST output ceiling, because the answer has to fit in what is left.
 *
 * Taking the smallest of both was the bug: a private-llm backend whose worker runs
 * LLM_MAX_TOKENS=16384, behind an agent reserving 8096+1024 from the global, answered with
 * 14564 output tokens into a window that had not been kept clear for them. Nothing errored —
 * the reserve is a promise this process makes to itself, and it was quietly making the wrong
 * one. Failover is up-only, so a call escalating from a small backend to a large one lands on
 * a request that was never built for the larger one's output.
 *
 * The cost is symmetrical to the window's: a call that lands on the cheap backend reserves
 * more than it needed. That is the correct side to be wrong on — an over-reserve shortens the
 * history, an under-reserve truncates the answer.
 *
 * `overheadTokens` is the system prompt plus the tool schemas — measured by the caller, because
 * only the caller knows which tools the MCP server actually returned.
 */
export function resolveBudget(input: {
  registry: Registry | null;
  provider: string;
  maxTokens: number;
  overheadTokens: number;
}): Budget {
  const specs: BackendSpec[] =
    input.registry && input.registry.backends.length > 0
      ? input.registry.backends
      : [{ name: input.provider, kind: input.provider as BackendKind }];

  let smallest = specs[0]!;
  for (const s of specs) if (windowOf(s) < windowOf(smallest)) smallest = s;
  const contextTokens = windowOf(smallest);

  let loudest = specs[0]!;
  for (const s of specs) {
    if (outputOf(s, input.maxTokens) > outputOf(loudest, input.maxTokens)) loudest = s;
  }
  const reserveTokens = outputOf(loudest, input.maxTokens) + BUDGET_SAFETY_MARGIN;

  const available = contextTokens - reserveTokens - input.overheadTokens;
  if (available <= 0) {
    throw new Error(
      `LLM backend "${smallest.name}" has a ${contextTokens}-token window, which leaves no room ` +
      `for conversation: reserve ${reserveTokens} (backend "${loudest.name}" may emit ` +
      `${outputOf(loudest, input.maxTokens)} output tokens) + system prompt and tools ` +
      `${input.overheadTokens} already exceed it. Raise LLM_BACKEND_*_CONTEXT_TOKENS, lower ` +
      `LLM_BACKEND_*_MAX_TOKENS or MAX_TOKENS, or shorten prompts/system.md.`
    );
  }
  return { contextTokens, reserveTokens };
}
