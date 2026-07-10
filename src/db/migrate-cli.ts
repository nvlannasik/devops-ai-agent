// Standalone migration runner — run as a K8s Job/initContainer before rollout,
// or locally with `npm run migrate`. The app also runs this on startup (advisory-locked),
// so this is for operators who prefer migrations decoupled from app boot.
import { config } from "../config/index.js";
import { createPool } from "./pool.js";
import { runMigrations } from "./migrate.js";
import logger from "../utils/logger/index.js";

async function main(): Promise<void> {
  if (!config.incidents.enabled) {
    logger.error("[migrate] DB_HOST not set — nothing to migrate");
    process.exit(1);
  }
  const pool = createPool(2);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error(`[migrate] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
