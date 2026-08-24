import { buildStaticSystemPrompt } from "../agent/prompts/system.js";
import { estimateTokens, BUDGET_SAFETY_MARGIN } from "../agent/context/budget.js";
import { windowOf } from "../agent/context/resolve-budget.js";
import { parseRegistry, type BackendSpec, type BackendKind } from "../agent/llm/registry.js";
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
  /**
   * The core prompt, and the TEXT of it — not just its size.
   *
   * `body` is what `buildStaticSystemPrompt()` returned, which reads prompts/system.md ONCE and
   * caches it for the life of the process. That is exactly why it is worth rendering: the file
   * is editable without a rebuild, so what git holds, what is on the pod's disk, and what this
   * process is actually sending can all be three different things — and only the third decides
   * what the agent says. Nothing else exposes it short of an exec into the pod.
   */
  core: { lines: number; chars: number; tokens: number; body: string };
  skills: SkillView[];
  backends: BackendBudget[];
  /** The smallest window — the one every request is actually built to fit. */
  effective: { backend: string; available: number };
}

/**
 * The backends whose windows this page reports.
 *
 * Both inputs are parameters rather than reads off `config` and `process.env`, because
 * `config.llm.provider` is frozen when `config/index.ts` is imported: nothing a test does later can
 * make `buildContextView` take the router branch. Left inline, the branch and its catch are
 * unreachable from any test, and deleting the whole ternary keeps the suite green.
 */
export function backendSpecs(provider: string, env: NodeJS.ProcessEnv): BackendSpec[] {
  // The same single-spec shape resolve-budget.ts:33 builds for its no-registry branch, cast the
  // same way. windowOf's second `??` is what catches an unrecognised provider: it lands on the
  // conservative private-llm window instead of assuming 200k.
  const single: BackendSpec[] = [{ name: provider, kind: provider as BackendKind }];
  // Same fallback topology.ts makes for its registryError: a registry that will not parse is
  // worth a degraded page, not a 500 — and this page is where an operator would go to see why.
  try {
    return provider === "router" ? parseRegistry(env).backends : single;
  } catch {
    return single;
  }
}

/**
 * Everything on /context, computed from config and the in-memory registry. Reads no database and
 * makes no call, which is what lets the page render while Postgres is down.
 */
export function buildContextView(
  skills: readonly SkillView[],
  toolCount: number,
  toolsJson: string,
  specs: readonly BackendSpec[] = backendSpecs(config.llm.provider, process.env)
): ContextView {
  const prompt = buildStaticSystemPrompt();
  const core = {
    lines: prompt.split("\n").length,
    chars: prompt.length,
    tokens: estimateTokens(prompt),
    body: prompt,
  };
  const toolTokens = toolCount > 0 ? estimateTokens(toolsJson) : 0;
  const reserve = config.llm.maxTokens + BUDGET_SAFETY_MARGIN;

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
