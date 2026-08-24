import http from "node:http";
import { randomBytes } from "node:crypto";
import { config } from "../config/index.js";
import logger, { errDetail } from "../utils/logger/index.js";
import { DashboardQueries } from "./queries.js";
import { parseFilters, parseRange } from "./filters.js";
import { contextPage, detailPage, errorPage, listPage, loginPage, overviewPage, promptPage, skillPage, topologyPage } from "./views.js";
import { buildTopology } from "./topology.js";
import { buildContextView, type ContextView, type SkillView } from "./context.js";
import type { McpTool } from "./topology.js";
import {
  LoginThrottle,
  SESSION_COOKIE,
  checkPassword,
  clearedCookie,
  cookieValue,
  mintSession,
  safeNext,
  sessionCookie,
  verifySession,
} from "./auth.js";

export type Route =
  | { kind: "overview" | "list" | "health" | "notfound" | "topology" | "context" | "prompt" | "login" | "logout" }
  | { kind: "detail"; id: number }
  | { kind: "skill"; name: string };

export function matchRoute(pathname: string): Route {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === "" || p === "/") return { kind: "overview" };
  if (p === "/healthz") return { kind: "health" };
  if (p === "/login") return { kind: "login" };
  if (p === "/logout") return { kind: "logout" };
  if (p === "/incidents") return { kind: "list" };
  if (p === "/topology") return { kind: "topology" };
  if (p === "/context") return { kind: "context" };
  // Top level, NOT /context/something, and that is structural rather than stylistic: a skill's
  // name is a filename, the skill route below matches one path segment under /context, and so
  // any reserved word there could one day be shadowed by a file someone adds to prompts/skills.
  // A route that cannot collide beats a guard that has to remember to.
  if (p === "/prompt") return { kind: "prompt" };
  // The name is matched loosely and resolved against the loaded skills, not against this
  // pattern: a page that 404s from the router would have to repeat the loader's NAME_RE
  // (agent/skills/index.ts) and the two would drift. The cap is what keeps a megabyte-long
  // path from being decoded and compared at all. decodeURIComponent throws on a malformed
  // %-escape — that is a 404, not a 500, so it is caught here rather than left to bubble.
  const s = /^\/context\/([^/]{1,128})$/.exec(p);
  if (s) {
    try {
      return { kind: "skill", name: decodeURIComponent(s[1]!) };
    } catch {
      return { kind: "notfound" };
    }
  }
  // digit count capped at 15: any 15-digit string is < 10^15, safely under
  // Number.MAX_SAFE_INTEGER (~9.007e15, 16 digits) — so isSafeInteger below is never the
  // thing doing the rejecting for an in-bound match, it is defense in depth. Without the
  // cap, a 40-digit id parses to a huge-but-finite float and a 309+ digit id parses to
  // Infinity — both are "digits only" and would otherwise reach queries.detail(id) as a
  // bound parameter, where Postgres rejects them as invalid integer input (500) instead
  // of this being the 404 a nonsense id deserves.
  const m = /^\/incidents\/(\d{1,15})$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    if (Number.isSafeInteger(id)) return { kind: "detail", id };
  }
  return { kind: "notfound" };
}

// Which methods each route answers. Everything not named here is read-only and GET-only,
// which is still true of every page: the two exceptions both act on the session, not on data.
export const METHODS: Partial<Record<Route["kind"], readonly string[]>> = {
  login: ["GET", "POST"],
  logout: ["POST"],
};

type Send = (code: number, body: string, type?: string, extra?: Record<string, string>) => void;
type Redirect = (to: string, extra?: Record<string, string>) => void;

// Every page but one runs no JavaScript at all — views.test.ts asserts it — and gets no
// `script-src` whatsoever, which is the strongest form of the claim: `default-src 'none'`
// already covers scripts, so a missed esc() on the incident pages (the ones that render LLM
// output and Alertmanager labels) is inert rather than exploitable.
//
// /topology is the exception. Its pan/zoom needs a listener, so that ONE response names a
// fresh nonce and the inline block carries it. Never 'unsafe-inline': that would hand the
// exemption to any injected <script> too, and the nonce is what keeps it to ours.
// style-src 'unsafe-inline' remains for the inline <style> block. form-action pins where the
// password may be posted (it does NOT inherit from default-src), and frame-ancestors stops
// the page being framed and clickjacked into a sign-out.
const csp = (nonce?: string): string =>
  "default-src 'none'; style-src 'unsafe-inline'; " +
  (nonce ? `script-src 'nonce-${nonce}'; ` : "") +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// Per response, never reused: a nonce an attacker can predict is 'unsafe-inline' with extra
// steps. base64url so the same string is legal both in the header and in the attribute.
const newNonce = (): string => randomBytes(16).toString("base64url");

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly queries: DashboardQueries;
  private readonly mcpTools: () => readonly McpTool[];
  private readonly skills: () => readonly SkillView[];
  private readonly throttle = new LoginThrottle();

  // A getter, not a snapshot: the dashboard starts before — and outlives — any given MCP
  // connection, so a list captured at construction time would be permanently empty. McpTool is
  // the dashboard's own two-field shape, not the agent's ToolDefinition — this is the whole
  // dependency the dashboard has on the agent, and keeping it structural means neither side
  // imports the other's types.
  constructor(
    queries?: DashboardQueries,
    mcpTools?: () => readonly McpTool[],
    skills?: () => readonly SkillView[]
  ) {
    this.queries = queries ?? new DashboardQueries();
    this.mcpTools = mcpTools ?? (() => []);
    this.skills = skills ?? (() => []);
  }

  async start(): Promise<void> {
    if (!config.dashboard.enabled) return;

    this.server = http.createServer((req, res) => {
      // Backstop, not the primary defense (handle() already catches internally around
      // both URL parsing and query execution). `handle()` is async and this callback
      // discards its returned promise — without this .catch, any future edit that adds
      // a throwing line outside handle()'s own try blocks becomes an unhandled rejection
      // again, and Node has no process-level handler for one: it kills the whole agent
      // over a single malformed request. Keep this even though it should never fire.
      this.handle(req, res).catch((err) => {
        logger.error(`[dashboard] unhandled error in request handler (agent unaffected): ${errDetail(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("Internal error");
        }
      });
    });

    // Deliberately NOT fatal, unlike the config validation at boot. That rule exists for
    // things that make the agent unable to do its job; a port conflict on a statistics
    // page does not. Killing the pod here would trade handled incidents for unhandled ones.
    this.server.on("error", (err) => {
      logger.error(`[dashboard] listener failed, dashboard disabled (agent unaffected): ${errDetail(err)}`);
      this.server = null;
    });

    await new Promise<void>((resolve) => {
      // listen() throws SYNCHRONOUSLY on a bad port number (ERR_SOCKET_BAD_PORT), and a
      // synchronous throw in here rejects the promise instead of reaching the "error"
      // handler above — which only ever sees ASYNC bind failures like EADDRINUSE. A
      // rejected start() propagates to main()'s catch and exits the pod: the exact
      // outcome the exemption in the design's §8 exists to prevent. Config validation
      // makes a bad port unreachable; this makes it survivable anyway.
      try {
        this.server!.listen(config.dashboard.port, () => {
          logger.info(
            `[dashboard] listening on :${config.dashboard.port} (read-only, ` +
            (config.dashboard.password
              ? `password required)`
              : `DASHBOARD_PASSWORD unset — serving 503 until it is set)`)
          );
          resolve();
        });
        this.server!.once("error", () => resolve());
      } catch (err) {
        logger.error(`[dashboard] could not listen, dashboard disabled (agent unaffected): ${errDetail(err)}`);
        this.server = null;
        resolve();
      }
    });
  }

  private authenticated(req: http.IncomingMessage, password: string): boolean {
    return verifySession(cookieValue(req.headers.cookie, SESSION_COOKIE), password);
  }

  // 4 KiB for a form with two short fields. The cap is the point: without it, a request that
  // announces no length can stream for as long as it likes into a process whose actual job is
  // running investigations.
  private async readBody(req: http.IncomingMessage, limit = 4096): Promise<string | null> {
    // The declared length settles it before a byte is read; the running total below is for
    // chunked bodies, which declare nothing.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return null;

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) {
          // Paused, not destroyed: the caller still has to write a response onto this
          // socket, and destroying the request resets the connection out from under it —
          // the client then sees a dropped connection instead of being told what was wrong.
          req.pause();
          return null;
        }
        chunks.push(chunk as Buffer);
      }
    } catch {
      // an aborted or reset upload — indistinguishable from a truncated form, and treated
      // the same way: no credential, no session
      return null;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async login(req: http.IncomingMessage, password: string, send: Send, redirect: Redirect): Promise<void> {
    const key = req.socket.remoteAddress ?? "unknown";

    const waitMs = this.throttle.retryAfterMs(key);
    if (waitMs > 0) {
      const secs = Math.ceil(waitMs / 1000);
      const wait = secs > 60 ? `${Math.ceil(secs / 60)} minutes` : `${secs} seconds`;
      return send(429, loginPage({ error: `Too many sign-in attempts. Try again in ${wait}.` }), undefined, {
        "retry-after": String(secs),
      });
    }

    const body = await this.readBody(req);
    if (body === null) {
      return send(400, loginPage({ error: "That sign-in did not arrive intact. Try again." }));
    }

    const form = new URLSearchParams(body);
    const next = safeNext(form.get("next"));
    if (!checkPassword(form.get("password") ?? "", password)) {
      this.throttle.fail(key);
      // Bounded by the throttle above, so this cannot be used to flood the log — and it is
      // the only record that anyone is trying the door.
      logger.warn(`[dashboard] failed sign-in from ${key}`);
      return send(401, loginPage({ error: "That password is not right. Check it and try again.", next }));
    }

    this.throttle.succeed(key);
    logger.info(`[dashboard] sign-in from ${key}`);
    return redirect(next, { "set-cookie": sessionCookie(mintSession(password), config.dashboard.cookieSecure) });
  }

  /**
   * Everything /context and /prompt render from, built the same way for both.
   *
   * Two callers now, and they must agree: the prompt page states the size of the text it is
   * showing, and a second construction here would let those two numbers describe different
   * strings.
   */
  private contextView(): ContextView {
    const tools = this.mcpTools();
    return buildContextView(this.skills(), tools.length, JSON.stringify(tools));
  }

  /**
   * The rail's badge count, or undefined if it cannot be read.
   *
   * undefined rather than 0 on failure, and the distinction is the point: a zero badge would
   * assert that nothing is firing, which is exactly the wrong thing to say when the reason we
   * have no number is that the database did not answer. No badge says nothing.
   */
  private async openCount(): Promise<number | undefined> {
    if (!this.queries.enabled) return undefined;
    try {
      return await this.queries.openIncidents();
    } catch (err) {
      logger.warn(`[dashboard] open-incident count failed, rendering without the badge: ${errDetail(err)}`);
      return undefined;
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (
      code: number,
      body: string,
      type = "text/html; charset=utf-8",
      extra: Record<string, string> = {}
    ) => {
      res.writeHead(code, {
        "content-type": type,
        "cache-control": "no-store",
        // The script-free policy. /topology overrides it through `extra` with its own
        // nonce — see csp() above for what each directive is holding down.
        "content-security-policy": csp(),
        "x-content-type-options": "nosniff",
        ...extra,
      });
      res.end(body);
    };

    // 303, not 302: after a POST it is the status that tells every browser to follow with a
    // GET rather than repeating the password submission at the new location.
    const redirect = (to: string, extra: Record<string, string> = {}) =>
      send(303, "", "text/plain; charset=utf-8", { location: to, ...extra });

    let url: URL;
    let route: Route;
    try {
      // `new URL()` needs no I/O to throw: Node's HTTP parser accepts request-targets
      // (e.g. an absolute-form URI with a malformed authority) that this constructor
      // rejects with a TypeError — routine internet-scanner noise. Caught here,
      // deliberately separate from the query try below, so a parse failure is its own 400
      // rather than the query layer's 500. Before the session check on purpose: a request
      // this server cannot parse has no path to authenticate.
      url = new URL(req.url ?? "/", `http://localhost:${config.dashboard.port}`);
      route = matchRoute(url.pathname);
    } catch (err) {
      logger.error(`[dashboard] malformed request-target ${req.url ?? "?"}: ${errDetail(err)}`);
      return send(400, errorPage("Bad request", "The request could not be parsed."));
    }

    // Still read-only by contract — the two routes with a POST act on the session, not on
    // data. Checked per route rather than globally so a POST to a page keeps saying 405.
    const allowed = METHODS[route.kind] ?? ["GET"];
    if (!allowed.includes(req.method ?? "")) {
      return send(405, errorPage("Method not allowed", "This dashboard is read-only."), "text/html; charset=utf-8", {
        allow: allowed.join(", "),
      });
    }

    // Ahead of the password gate below: the probe decides whether this pod stays Ready, and
    // a misconfigured dashboard must not be able to take the agent out of service. It reads
    // nothing and reveals nothing.
    if (route.kind === "health") return send(200, "ok", "text/plain; charset=utf-8");

    // Fail closed, and say why. Serving the incident history anonymously because a secret is
    // missing is the one outcome worth an outage on this port — but only on this port: the
    // dashboard is still the component that may not stop the pod (design §8).
    const password = config.dashboard.password;
    if (!password) {
      return send(
        503,
        errorPage(
          "Dashboard unavailable",
          "DASHBOARD_PASSWORD is not set, so this dashboard cannot verify who is asking. Set it to enable sign-in.",
          "bare"
        )
      );
    }

    if (route.kind === "login") {
      if (req.method === "GET") {
        // Already signed in: the form would be a dead end that re-asks for a password the
        // browser is already holding.
        if (this.authenticated(req, password)) return redirect(safeNext(url.searchParams.get("next")));
        return send(200, loginPage({ next: safeNext(url.searchParams.get("next")) }));
      }
      return this.login(req, password, send, redirect);
    }

    if (route.kind === "logout") {
      // Unconditional: signing out an already-signed-out browser is the outcome either way,
      // and refusing it would only ever confuse someone whose session had just expired.
      return redirect("/login", { "set-cookie": clearedCookie(config.dashboard.cookieSecure) });
    }

    if (!this.authenticated(req, password)) {
      // The path is carried through the sign-in so a bookmarked incident survives a session
      // expiring — safeNext() is what keeps that from becoming an open redirect.
      const next = url.pathname + url.search;
      return redirect(`/login?next=${encodeURIComponent(safeNext(next))}`);
    }

    // resolved from the URL alone — must 404 before the database gate below, otherwise an
    // unrelated path rides the "no database configured" 200 (or, worse, reaches the query
    // layer once a database IS configured) instead of a plain not-found
    if (route.kind === "notfound") return send(404, errorPage("Not found", "No such page."));

    // deliberately before the database gate: this page reads no database, which makes it the
    // one page that still works while Postgres is down — which is when it is most wanted
    if (route.kind === "topology") {
      // The one place the two halves meet: the same nonce goes into the header and into the
      // <script> tag. Minted here rather than per-page so there is exactly one of them and
      // nothing has to agree about how it was generated.
      const nonce = newNonce();
      // The badge is chrome, so every page carries it — including the two that need no database
      // of their own. It is a cached count, so asking for it here costs nothing most of the
      // time, and a failure to read it must not take out a page that does not otherwise depend
      // on Postgres: it falls back to no badge rather than to an error.
      const open = await this.openCount();
      return send(200, topologyPage(buildTopology(this.mcpTools()), nonce, open), "text/html; charset=utf-8", {
        "content-security-policy": csp(nonce),
      });
    }

    if (route.kind === "context") {
      // openCount was missing here and nowhere else: /context rendered without the rail's
      // badge while every other page carried it. A page-by-page argument is a page-by-page
      // chance to forget one.
      return send(
        200,
        contextPage(this.contextView(), await this.openCount()),
        "text/html; charset=utf-8"
      );
    }

    // Same side of the database gate as /context, for the same reason: a skill is read out of
    // the running process, so this page answers while Postgres is down.
    if (route.kind === "skill") {
      const skill = this.skills().find((s) => s.name === route.name);
      if (!skill) return send(404, errorPage("Not found", `No skill named ${route.name}.`));
      return send(200, skillPage(skill, await this.openCount()), "text/html; charset=utf-8");
    }

    if (route.kind === "prompt") {
      // Same side of the database gate as /context and a skill page: the prompt is read out of
      // the running process, so it renders while Postgres is down — which is one of the times
      // someone most wants to know what the agent is being told.
      return send(
        200,
        promptPage(this.contextView(), await this.openCount()),
        "text/html; charset=utf-8"
      );
    }

    if (!this.queries.enabled) {
      return send(200, errorPage("No database configured", "Set DB_HOST to enable incident history."));
    }

    try {
      switch (route.kind) {
        // ONE instant per response, taken here and threaded into every page that renders a
        // relative timestamp. Computed per row instead, a list rendered across a minute
        // boundary would say "1h ago" and "59m ago" about two incidents a second apart.
        case "overview": {
          const now = new Date();
          const range = parseRange(url.searchParams);
          const [o, recent, open] = await Promise.all([
            this.queries.overview(range),
            this.queries.list(parseFilters(new URLSearchParams())),
            this.openCount(),
          ]);
          return send(200, overviewPage(o, recent.rows, now, open));
        }
        case "list": {
          const now = new Date();
          const f = parseFilters(url.searchParams);
          const [p, open] = await Promise.all([this.queries.list(f), this.openCount()]);
          return send(200, listPage(p, f, now, open));
        }
        case "detail": {
          const now = new Date();
          const [d, open] = await Promise.all([this.queries.detail(route.id), this.openCount()]);
          if (!d) return send(404, errorPage("Not found", `No incident with id ${route.id}.`));
          return send(200, detailPage(d, now, open));
        }
      }
    } catch (err) {
      // never throw into the process: an unhandled rejection here would take down the
      // agent, and the agent's job is investigating alerts
      logger.error(`[dashboard] ${url.pathname} failed: ${errDetail(err)}`);
      return send(500, errorPage("Query failed", "The database did not answer in time."));
    }
  }

  // Bounded on purpose. `server.close()` waits for in-flight requests, and a dashboard
  // request can be stuck on a pool that is waiting on an unreachable Postgres —
  // statement_timeout is server-side and cannot fire when the server is what is missing.
  // Unbounded, one open browser tab would hold the whole shutdown past the grace period
  // and Slack would keep delivering to a terminating pod. The auxiliary surface does not
  // get to delay the critical ones: it is also shut down last (see index.ts).
  async stop(timeoutMs = 3000): Promise<void> {
    const server = this.server;
    if (server) {
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn(`[dashboard] did not close within ${timeoutMs}ms — forcing connections shut`);
            server.closeAllConnections();
            resolve();
          }, timeoutMs).unref()
        ),
      ]);
      this.server = null;
    }
    await this.queries.close();
  }
}
