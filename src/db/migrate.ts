import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import type { Pool } from "pg";
import logger from "../utils/logger/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// fixed key so every pod/process takes the same advisory lock for migrations
const LOCK_KEY = 4927312;

// migrations/ lives at project root (not compiled by tsc). Same dev/prod resolution
// trick as prompts/system.md: dev = src/db, prod = dist/src/db.
function migrationsDir(): string {
  const candidates = [join(__dirname, "../../migrations"), join(__dirname, "../../../migrations")];
  for (const p of candidates) {
    try {
      readdirSync(p);
      return p;
    } catch {
      continue;
    }
  }
  throw new Error("Could not find migrations/ directory");
}

// pure: .sql files not yet applied, in lexical order (001_, 002_, ...)
export function pendingMigrations(files: string[], applied: Set<string>): string[] {
  return files.filter((f) => f.endsWith(".sql")).sort().filter((f) => !applied.has(f));
}

// Apply pending migrations under an advisory lock so concurrent pod startups
// (autoscaling) serialize instead of racing on DDL. Each file runs in its own txn.
export async function runMigrations(pool: Pool): Promise<void> {
  const dir = migrationsDir();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set<string>(rows.map((r: { version: string }) => r.version));
    const pending = pendingMigrations(readdirSync(dir), applied);

    if (pending.length === 0) {
      logger.info("[migrate] schema up to date");
      return;
    }
    for (const file of pending) {
      const sql = readFileSync(join(dir, file), "utf-8");
      logger.info(`[migrate] applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    logger.info(`[migrate] applied ${pending.length} migration(s)`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
