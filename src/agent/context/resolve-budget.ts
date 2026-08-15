import type { Registry, BackendSpec, BackendKind } from "../llm/registry.js";
import { BUDGET_SAFETY_MARGIN, DEFAULT_CONTEXT_TOKENS, type Budget } from "./budget.js";

// DEFAULT_CONTEXT_TOKENS is total over BackendKind, so this only falls through to the second `??`
// when resolveBudget's no-registry branch casts an arbitrary provider string to BackendKind. The
// fallback is the smallest default on purpose: an unrecognised provider gets the conservative
// window rather than a 200k assumption that fails at request time.
export const windowOf = (spec: BackendSpec): number =>
  spec.contextTokens ?? DEFAULT_CONTEXT_TOKENS[spec.kind] ?? DEFAULT_CONTEXT_TOKENS["private-llm"];

/**
 * One budget for the whole process, resolved at boot.
 *
 * The router picks a backend AFTER the request has been built, so a request must fit the
 * SMALLEST window it might land in. Failover is up-only (light -> heavy), so the smallest
 * backend is also the usual first attempt; the cost is that a call which happens to land on
 * Claude is sometimes smaller than it needed to be.
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
  const reserveTokens = input.maxTokens + BUDGET_SAFETY_MARGIN;

  const specs: BackendSpec[] =
    input.registry && input.registry.backends.length > 0
      ? input.registry.backends
      : [{ name: input.provider, kind: input.provider as BackendKind }];

  let smallest = specs[0]!;
  for (const s of specs) if (windowOf(s) < windowOf(smallest)) smallest = s;
  const contextTokens = windowOf(smallest);

  const available = contextTokens - reserveTokens - input.overheadTokens;
  if (available <= 0) {
    throw new Error(
      `LLM backend "${smallest.name}" has a ${contextTokens}-token window, which leaves no room ` +
      `for conversation: reserve ${reserveTokens} + system prompt and tools ${input.overheadTokens} ` +
      `already exceed it. Raise LLM_BACKEND_*_CONTEXT_TOKENS, lower MAX_TOKENS, or shorten prompts/system.md.`
    );
  }
  return { contextTokens, reserveTokens };
}
