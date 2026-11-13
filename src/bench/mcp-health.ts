/**
 * Is the MCP server this run reads the cluster through still there?
 *
 * 2026-11-13, a 25x5 run: the `kubectl port-forward` to the MCP server died three hours in, and
 * the runner went on for two more — every tool call "MCP connection failed", every attempt scored
 * as the agent's. C02, C03 and C06 went 0/5 against a model that could not read a single pod, and
 * C08 "passed" four times for the same reason. Nothing stopped it, and at the end it would have
 * committed that score. An attempt without tools measures the tunnel, not the agent.
 *
 * So the runner asks before and after every attempt. `/health` is open on the MCP server (no
 * token), and it is the server's own route — a tunnel that is up with nothing behind it fails it.
 */
export const healthUrl = (mcpHttpUrl: string): string => new URL("/health", mcpHttpUrl).toString();

export async function mcpReachable(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** True as soon as it answers; false when it has not within `timeoutMs`. */
export async function waitForMcp(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; probe?: (url: string) => Promise<boolean>; sleep?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  const { timeoutMs = 300_000, intervalMs = 5_000, probe = mcpReachable, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = opts;
  for (let waited = 0; ; waited += intervalMs) {
    if (await probe(url)) return true;
    if (waited >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}
