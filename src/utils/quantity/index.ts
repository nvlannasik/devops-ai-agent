// Kubernetes quantities, shared by the benchmark's `greaterThan` matcher and the no-op guard.
// It lives here rather than in either of them because a guard that imports from `bench/` inverts
// the dependency — the benchmark measures the agent, never the other way round.

// Kubernetes quantity -> a number in base units. Binary and decimal suffixes mean different
// things (1Mi = 1048576, 1M = 1000000) and conflating them would pass a proposal that is 5%
// short. `m` is milli, for the CPU fields.
const SUFFIX: Record<string, number> = {
  "": 1, m: 1e-3,
  k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};

export function parseQuantity(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(v.trim());
  if (!m) return null;
  const mult = SUFFIX[m[2]!];
  return mult === undefined ? null : Number(m[1]) * mult;
}
