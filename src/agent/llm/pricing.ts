/**
 * What an LLM call cost, from prices the operator states per backend — never from a price table in
 * code: a contract price is not the list price, and a wrong built-in number would look exact.
 * `LLM_BACKEND_<N>_PRICE_INPUT` / `_PRICE_OUTPUT` (both required) and `_PRICE_CACHE_READ`
 * (optional), USD per million tokens. A backend without both has NO price — the dashboard shows
 * its tokens only, rather than a $0 that reads as free.
 */
/**
 * `inputIncludesCache`: OpenAI's prompt_tokens INCLUDES the cached tokens (their count is a subset,
 * prompt_tokens_details.cached_tokens), Anthropic's input_tokens does NOT — so an OpenAI-shaped
 * backend pays full price only for input minus cache reads. Taken from the backend's kind: claude
 * is Anthropic-shaped; openai-compatible and private-llm are OpenAI-shaped (the worker translates
 * to OpenAI and reports prompt_tokens).
 * ponytail: a private-llm worker on LLM_API_FORMAT=anthropic reports Anthropic counts and would
 * be under-billed by its cache reads; state the kind here if that worker is ever priced.
 */
export interface Price { input: number; output: number; cacheRead?: number; inputIncludesCache?: boolean }

const usd = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function backendPrices(env: NodeJS.ProcessEnv = process.env): Map<string, Price> {
  const out = new Map<string, Price>();
  for (let i = 1; i <= 20; i++) {
    const name = env[`LLM_BACKEND_${i}_NAME`]?.trim();
    if (!name) continue;
    const input = usd(env[`LLM_BACKEND_${i}_PRICE_INPUT`]);
    const output = usd(env[`LLM_BACKEND_${i}_PRICE_OUTPUT`]);
    if (input === undefined || output === undefined) continue;
    const cacheRead = usd(env[`LLM_BACKEND_${i}_PRICE_CACHE_READ`]);
    const inputIncludesCache = env[`LLM_BACKEND_${i}_KIND`]?.trim() !== "claude";
    out.set(name, { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(inputIncludesCache ? { inputIncludesCache } : {}) });
  }
  return out;
}

/** USD for these tokens, or null when the backend has no price. Cache reads count only when priced. */
export function costUsd(p: Price | undefined, t: { input: number; output: number; cacheRead: number }): number | null {
  if (!p) return null;
  if (p.cacheRead === undefined) return (t.input * p.input + t.output * p.output) / 1_000_000;
  const fullPrice = p.inputIncludesCache ? Math.max(0, t.input - t.cacheRead) : t.input;
  return (fullPrice * p.input + t.output * p.output + t.cacheRead * p.cacheRead) / 1_000_000;
}
