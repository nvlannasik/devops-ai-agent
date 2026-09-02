import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REDIS_KEYS as MEMORY_KEYS } from "../agent/memory/index.js";
import { REDIS_KEYS as DEDUP_KEYS } from "../agent/dedup/index.js";

// What the agent's two stateful dependencies actually HOLD — the answer to "where did that
// incident go" and "what is in Redis", which is a real 3am question and was nowhere on this
// dashboard.
//
// Both lists are derived, never transcribed. That is the whole design of this file: a hand-kept
// list of five tables is correct until migration 008 and then quietly wrong, and this page's
// contract is that it reports the process rather than a description of it.
//   - Postgres: parsed out of the shipped `migrations/*.sql`, which are the same files
//     runMigrations() applies at boot.
//   - Redis: composed from the constants the writing modules own, guarded by a test in
//     `agent/memory/index.test.ts` that fails if a key reaches a redis call without being
//     declared there.
//
// Nothing here probes. No connection is opened and no query is run — consistent with the rest
// of the topology page, which reads configuration and says so.

export interface Store {
  label: string;
  detail: string;
}

// CREATE TABLE, with or without IF NOT EXISTS, and with or without a schema qualifier. Not a
// SQL parser: these are our own migrations, written by us, and the one thing a parser would buy
// — surviving syntax we do not write — is not worth a dependency. A malformed file yields no
// match rather than an error, which is the right failure for a page that must render on
// anything.
const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gi;

let tableCache: Store[] | null = null;

/**
 * Resolves the package root by walking up for package.json rather than counting `..` segments,
 * for the same reason `assets.ts` does: the count differs between `src/…` under tsx in dev and
 * `dist/src/…` in the image, and a path correct in one is a silent empty list in the other.
 */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The tables the incident memory is made of, in migration order — which is also the order they
 * came to exist, and reads as the history of the feature set.
 *
 * Read once and cached: the migrations are baked into the image and cannot change while the
 * process lives, and this is called per request. An empty list is a supported state (the
 * directory is absent in some deployment) and renders as a card with nothing to expand, not as
 * an error.
 */
export function postgresTables(): Store[] {
  if (tableCache) return tableCache;
  const root = packageRoot();
  const dir = root ? join(root, "migrations") : null;
  if (!dir || !existsSync(dir)) return (tableCache = []);

  const seen = new Map<string, string>();
  // Lexical order is migration order — the files are numbered `001_`… precisely so that both
  // this and runMigrations() get the same sequence from a plain sort.
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const m of sql.matchAll(CREATE_TABLE)) {
      const name = m[1]!;
      // First migration to create it wins: a later `IF NOT EXISTS` on the same table is a
      // re-declaration, not a second table.
      if (!seen.has(name)) seen.set(name, file);
    }
  }
  return (tableCache = [...seen].map(([name, file]) => ({ label: name, detail: file })));
}

/**
 * The Redis key namespaces this agent writes. Composed from the two modules that own them, so
 * this is a view of the code rather than a copy of it.
 */
export function redisNamespaces(): Store[] {
  return [...Object.values(MEMORY_KEYS), ...Object.values(DEDUP_KEYS)].map((k) => ({
    label: `${k.prefix}:*`,
    detail: k.holds,
  }));
}
