import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve path: works for both dev (src/) and prod (dist/)
// prompts/system.md lives at project root, so walk up from src/agent/prompts/
function resolvePromptPath(): string {
  // dev: __dirname = <root>/src/agent/prompts → walk up 3 levels
  // prod: __dirname = <root>/dist/src/agent/prompts → walk up 4 levels
  const candidates = [
    join(__dirname, "../../../prompts/system.md"),   // dev
    join(__dirname, "../../../../prompts/system.md"), // prod
  ];
  for (const p of candidates) {
    try {
      readFileSync(p); // test readability
      return p;
    } catch {
      continue;
    }
  }
  throw new Error("Could not find prompts/system.md");
}

let _cachedPrompt: string | null = null;

export function buildStaticSystemPrompt(): string {
  if (!_cachedPrompt) {
    _cachedPrompt = readFileSync(resolvePromptPath(), "utf-8").trim();
  }
  return _cachedPrompt;
}

export function buildTimeContext(): string {
  const now = new Date();
  const unix_now = Math.floor(now.getTime() / 1000);
  const unix_30m_ago = unix_now - 1800;
  const unix_1h_ago = unix_now - 3600;
  const unix_6h_ago = unix_now - 21600;

  return `[TIME CONTEXT — use these unix timestamps as tool parameters]
unix_now:     ${unix_now}  (${now.toISOString()})
unix_30m_ago: ${unix_30m_ago}
unix_1h_ago:  ${unix_1h_ago}
unix_6h_ago:  ${unix_6h_ago}

Prometheus default 1h range: start=${unix_1h_ago} end=${unix_now} step=60
Prometheus spike  30m range:  start=${unix_30m_ago} end=${unix_now} step=15
Loki default range:           start=${unix_30m_ago} end=${unix_now}`;
}
