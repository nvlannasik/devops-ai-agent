import { Pool } from "pg";
import { config } from "../config/index.js";

// Map libpq-style DB_SSL_MODE to pg's `ssl` option.
// require = encrypt without cert verification; verify-ca/verify-full = verify the cert.
function pgSsl(mode: string): false | { rejectUnauthorized: boolean } {
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode === "verify-ca" || mode === "verify-full") return { rejectUnauthorized: true };
  return false; // disable (default)
}

// connectionTimeoutMillis bounds the wait for a FREE POOL SLOT, which `statement_timeout`
// cannot: that one is server-side and never fires when the server is what is unreachable.
// Without it, waiters queue forever — which is how one stuck dashboard query used to hold
// an entire graceful shutdown open. Opt-in per caller so the agent's own pool keeps its
// existing behaviour.
//
// statementTimeoutMs goes in the startup packet rather than a `SET` issued from a pool
// 'connect' listener. Those listeners cannot be awaited: pg hands the fresh client straight
// to the query that was waiting for it, so the SET is still in flight when that query
// starts — which is both the "client.query() when the client is already executing a query"
// deprecation warning and, worse, a first query that runs with no statement_timeout at all.
export function createPool(max = 5, connectionTimeoutMillis?: number, statementTimeoutMs?: number): Pool {
  const { host, port, user, password, database, sslMode } = config.incidents.db;
  return new Pool({
    host, port, user, password, database, ssl: pgSsl(sslMode), max,
    ...(connectionTimeoutMillis !== undefined && { connectionTimeoutMillis }),
    ...(statementTimeoutMs !== undefined && { options: `-c statement_timeout=${statementTimeoutMs}` }),
  });
}
