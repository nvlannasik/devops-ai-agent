/**
 * What an LLM call cost, from prices the operator states per backend — never from a price table in
 * code: a contract price is not the list price, and a wrong built-in number would look exact.
 * `LLM_BACKEND_<N>_PRICE_INPUT` / `_PRICE_OUTPUT` (both required) and `_PRICE_CACHE_READ`
 * (optional), USD per million tokens. A backend without both has NO price — the dashboard shows
 * its tokens only, rather than a $0 that reads as free.
 */
export interface Price { input: number; output: number; cacheRead?: number }

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
    out.set(name, { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) });
  }
  return out;
}

/** USD for these tokens, or null when the backend has no price. Cache reads count only when priced. */
export function costUsd(p: Price | undefined, t: { input: number; output: number; cacheRead: number }): number | null {
  if (!p) return null;
  return (t.input * p.input + t.output * p.output + (p.cacheRead !== undefined ? t.cacheRead * p.cacheRead : 0)) / 1_000_000;
}
