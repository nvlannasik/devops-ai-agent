import { Pool } from "pg";
import { config } from "../config/index.js";

// Map libpq-style DB_SSL_MODE to pg's `ssl` option.
// require = encrypt without cert verification; verify-ca/verify-full = verify the cert.
function pgSsl(mode: string): false | { rejectUnauthorized: boolean } {
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode === "verify-ca" || mode === "verify-full") return { rejectUnauthorized: true };
  return false; // disable (default)
}

export function createPool(max = 5): Pool {
  const { host, port, user, password, database, sslMode } = config.incidents.db;
  return new Pool({ host, port, user, password, database, ssl: pgSsl(sslMode), max });
}
