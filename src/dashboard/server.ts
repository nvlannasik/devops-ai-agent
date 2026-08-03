import http from "node:http";
import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { DashboardQueries } from "./queries.js";
import { parseFilters } from "./filters.js";
import { detailPage, errorPage, listPage, overviewPage } from "./views.js";

export type Route =
  | { kind: "overview" | "list" | "health" | "notfound" }
  | { kind: "detail"; id: number };

export function matchRoute(pathname: string): Route {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === "" || p === "/") return { kind: "overview" };
  if (p === "/healthz") return { kind: "health" };
  if (p === "/incidents") return { kind: "list" };
  const m = /^\/incidents\/(\d+)$/.exec(p);
  if (m) return { kind: "detail", id: Number(m[1]) };
  return { kind: "notfound" };
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly queries: DashboardQueries;

  constructor(queries?: DashboardQueries) {
    this.queries = queries ?? new DashboardQueries();
  }

  async start(): Promise<void> {
    if (!config.dashboard.enabled) return;

    this.server = http.createServer((req, res) => void this.handle(req, res));

    // Deliberately NOT fatal, unlike the config validation at boot. That rule exists for
    // things that make the agent unable to do its job; a port conflict on a statistics
    // page does not. Killing the pod here would trade handled incidents for unhandled ones.
    this.server.on("error", (err) => {
      logger.error(`[dashboard] listener failed, dashboard disabled (agent unaffected): ${errDetail(err)}`);
      this.server = null;
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(config.dashboard.port, () => {
        logger.info(
          `[dashboard] listening on :${config.dashboard.port} ` +
          `(read-only, no auth — must not be routed by the Ingress)`
        );
        resolve();
      });
      this.server!.once("error", () => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: string, type = "text/html; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    // read-only by contract: nothing here mutates, so nothing but GET is accepted
    if (req.method !== "GET") return send(405, errorPage("Method not allowed", "This dashboard is read-only."));

    const url = new URL(req.url ?? "/", `http://localhost:${config.dashboard.port}`);
    const route = matchRoute(url.pathname);

    if (route.kind === "health") return send(200, "ok", "text/plain; charset=utf-8");

    // resolved from the URL alone — must 404 before the database gate below, otherwise an
    // unrelated path rides the "no database configured" 200 (or, worse, reaches the query
    // layer once a database IS configured) instead of a plain not-found
    if (route.kind === "notfound") return send(404, errorPage("Not found", "No such page."));

    if (!this.queries.enabled) {
      return send(200, errorPage("No database configured", "Set DB_HOST to enable incident history."));
    }

    try {
      switch (route.kind) {
        case "overview": {
          const [o, recent] = await Promise.all([
            this.queries.overview(),
            this.queries.list(parseFilters(new URLSearchParams("pageSize=10"))),
          ]);
          return send(200, overviewPage(o, recent.rows));
        }
        case "list": {
          const f = parseFilters(url.searchParams);
          const { rows, hasMore } = await this.queries.list(f);
          return send(200, listPage(rows, f, hasMore));
        }
        case "detail": {
          const d = await this.queries.detail(route.id);
          if (!d) return send(404, errorPage("Not found", `No incident with id ${route.id}.`));
          return send(200, detailPage(d));
        }
      }
    } catch (err) {
      // never throw into the process: an unhandled rejection here would take down the
      // agent, and the agent's job is investigating alerts
      logger.error(`[dashboard] ${url.pathname} failed: ${errDetail(err)}`);
      return send(500, errorPage("Query failed", "The database did not answer in time."));
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.queries.close();
  }
}
