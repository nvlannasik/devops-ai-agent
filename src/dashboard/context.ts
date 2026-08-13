import { buildStaticSystemPrompt } from "../agent/prompts/system.js";
import { estimateTokens, BUDGET_SAFETY_MARGIN, DEFAULT_CONTEXT_TOKENS } from "../agent/context/budget.js";
import { windowOf } from "../agent/context/resolve-budget.js";
import { parseRegistry } from "../agent/llm/registry.js";
import { config } from "../config/index.js";

// The dashboard's own shape, like McpTool in topology.ts: strings and numbers only, so neither
// side imports the other's types and no RegExp ever reaches a template.
export interface SkillView {
  name: string;
  description: string;
  when: string;
  chars: number;
  body: string;
}

export interface BackendBudget {
  name: string;
  model: string;
  window: number;
  reserve: number;
  core: number;
  tools: number;
  available: number;
}

export interface ContextView {
  core: { lines: number; chars: number; tokens: number };
  skills: SkillView[];
  backends: BackendBudget[];
  /** The smallest window — the one every request is actually built to fit. */
  effective: { backend: string; available: number };
}

/**
 * Everything on /context, computed from config and the in-memory registry. Reads no database and
 * makes no call, which is what lets the page render while Postgres is down.
 */
export function buildContextView(
  skills: readonly SkillView[],
  toolCount: number,
  toolsJson: string
): ContextView {
  const prompt = buildStaticSystemPrompt();
  const core = {
    lines: prompt.split("\n").length,
    chars: prompt.length,
    tokens: estimateTokens(prompt),
  };
  const toolTokens = toolCount > 0 ? estimateTokens(toolsJson) : 0;
  const reserve = config.llm.maxTokens + BUDGET_SAFETY_MARGIN;

  const single = [{
    name: config.llm.provider,
    kind: config.llm.provider as keyof typeof DEFAULT_CONTEXT_TOKENS,
    model: undefined as string | undefined,
    contextTokens: undefined as number | undefined,
  }];
  // Same fallback topology.ts makes for its registryError: a registry that will not parse is
  // worth a degraded page, not a 500 — and this page is where an operator would go to see why.
  let specs;
  try {
    specs = config.llm.provider === "router" ? parseRegistry(process.env).backends : single;
  } catch {
    specs = single;
  }

  const backends: BackendBudget[] = specs.map((s) => {
    // windowOf from Task 7, not a second copy of its body. This page has to report the same
    // window the agent actually budgets to; a duplicated default-by-kind chain diverges the day a
    // kind's default moves, and the page whose whole job is showing the budget shows the wrong one.
    const window = windowOf(s);
    return {
      name: s.name,
      model: s.model ?? "—",
      window,
      reserve,
      core: core.tokens,
      tools: toolTokens,
      available: window - reserve - core.tokens - toolTokens,
    };
  });

  const smallest = backends.reduce((a, b) => (b.available < a.available ? b : a));
  return { core, skills: [...skills], backends, effective: { backend: smallest.name, available: smallest.available } };
}
