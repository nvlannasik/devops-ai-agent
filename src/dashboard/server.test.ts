import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { DashboardServer, matchRoute, METHODS } from "./server.js";
import { DashboardQueries } from "./queries.js";
import { config } from "../config/index.js";
import { SESSION_COOKIE, mintSession } from "./auth.js";
import type { SkillView } from "./context.js";

// config is `as const` for the TYPE system only — nothing freezes it at runtime — so the
// dashboard can be turned on for this one isolated test-file process (node:test's default
// isolation is one child process per file) without an env var set before the static imports
// above already evaluated config.
type DashboardConfig = { enabled: boolean; port: number; password?: string; cookieSecure: boolean };
const dashboardConfig = config.dashboard as unknown as DashboardConfig;

const PASSWORD = "test-dashboard-password";
// Minting directly rather than posting the form: these tests are about what a valid session
// unlocks, and the login round-trip has its own tests below. Sessions are signed, not stored,
// so a token minted here is indistinguishable from one the server issued.
const authed = { headers: [`Cookie: ${SESSION_COOKIE}=${mintSession(PASSWORD)}`] };

test("matchRoute recognises the three pages and the probe", () => {
  assert.deepEqual(matchRoute("/"), { kind: "overview" });
  assert.deepEqual(matchRoute("/incidents"), { kind: "list" });
  assert.deepEqual(matchRoute("/healthz"), { kind: "health" });
  assert.deepEqual(matchRoute("/incidents/42"), { kind: "detail", id: 42 });
});

test("matchRoute recognises the two session routes", () => {
  assert.deepEqual(matchRoute("/login"), { kind: "login" });
  assert.deepEqual(matchRoute("/logout"), { kind: "logout" });
});

test("matchRoute tolerates a trailing slash", () => {
  assert.deepEqual(matchRoute("/incidents/"), { kind: "list" });
});

// A non-numeric id must not reach the query layer as text — it would be a type error at
// the database rather than a 404 here.
test("matchRoute rejects a non-numeric incident id", () => {
  assert.deepEqual(matchRoute("/incidents/abc"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/incidents/1;DROP TABLE incidents"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/incidents/-1"), { kind: "notfound" });
});

test("matchRoute returns notfound for anything else", () => {
  assert.deepEqual(matchRoute("/admin"), { kind: "notfound" });
  assert.deepEqual(matchRoute("/../etc/passwd"), { kind: "notfound" });
});

// An unbounded \d+ still matches "digits only" for an absurdly long string. A 40-digit id
// is a huge-but-finite float (not an integer any table's serial/bigint pk could hold); a
// 309+ digit id overflows to Infinity. Both would otherwise reach queries.detail(id) as a
// bound parameter and come back as a 500 from Postgres rejecting invalid integer input,
// instead of the 404 a nonsense id deserves — this must resolve locally, in matchRoute.
test("matchRoute rejects an incident id with an absurd digit count", () => {
  assert.deepEqual(matchRoute(`/incidents/${"9".repeat(40)}`), { kind: "notfound" });
  assert.deepEqual(matchRoute(`/incidents/${"9".repeat(400)}`), { kind: "notfound" });
});

// `new URL()` needs no I/O to throw, and Node's HTTP parser accepts request-targets that
// this constructor rejects (a malformed absolute-form URI). This must NOT reach fetch() or
// `new URL()` on the client side to construct — both normalise away exactly the malformed
// input this test needs, which is why the bug survived every prior check. A raw socket,
// sending the request line literally, is the only way to reproduce it.
test("a malformed request-target gets a clean 400, not a dead process", async () => {
  dashboardConfig.enabled = true;
  dashboardConfig.port = 0; // OS-assigned free port, avoids clashing with a fixed port
  dashboardConfig.password = PASSWORD;

  const dashboard = new DashboardServer(new DashboardQueries(null));
  await dashboard.start();
  // `server` is TS-private only (no real JS privacy) — reach in to read the OS-assigned
  // port back out, since we asked for port 0 above precisely to avoid a fixed test port
  const address = (dashboard as unknown as { server: { address(): net.AddressInfo } }).server.address();
  const port = address.port;

  const statusLine = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      // literal bytes on the wire: a request-target Node's HTTP parser accepts as a token
      // but that breaks `new URL(req.url, base)` — this is what a fetch client can't send
      sock.write("GET http://[glitch HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    sock.on("error", reject);
  });

  assert.match(statusLine, /^HTTP\/1\.1 400\b/);

  // process survival isn't just "this line executed" — an ordinary request must still
  // work afterward, proving the listener (and the process it runs in) is still healthy
  const followUp = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write("GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    sock.on("error", reject);
  });
  assert.match(followUp, /^HTTP\/1\.1 200\b/);

  await dashboard.stop();
});

// One live server for the HTTP-level contracts below. Each of these was mutation-checked:
// delete the behaviour it pins and the test goes red. Before them, the notfound-before-DB-gate
// ordering and the GET-only rule were both enforced by nothing — and a missing notfound guard
// is worse than a wrong status code, because "notfound" then falls through the switch, handle()
// resolves without ever calling res.end(), and the socket hangs until Node's 300s requestTimeout.
async function withServer<T>(
  fn: (port: number) => Promise<T>,
  opts: { unconfigured?: boolean; skills?: SkillView[] } = {}
): Promise<T> {
  dashboardConfig.enabled = true;
  dashboardConfig.port = 0;
  dashboardConfig.password = opts.unconfigured ? undefined : PASSWORD;
  dashboardConfig.cookieSecure = true;
  const dashboard = new DashboardServer(new DashboardQueries(null), undefined, () => opts.skills ?? []);
  await dashboard.start();
  const address = (dashboard as unknown as { server: { address(): net.AddressInfo } }).server.address();
  try {
    return await fn(address.port);
  } finally {
    await dashboard.stop();
  }
}

// Raw sockets rather than fetch() throughout: fetch follows redirects, normalises the
// request-target, and hides Set-Cookie — the three things most of these tests are about.
const raw = (
  port: number,
  requestLine: string,
  opts: { headers?: string[]; body?: string } = {}
): Promise<string> =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const body = opts.body ?? "";
      const lines = [requestLine, "Host: x", ...(opts.headers ?? [])];
      if (opts.body !== undefined) {
        lines.push("content-type: application/x-www-form-urlencoded");
        lines.push(`content-length: ${Buffer.byteLength(body)}`);
      }
      lines.push("Connection: close", "", body);
      sock.write(lines.join("\r\n"));
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
    sock.setTimeout(5000, () => reject(new Error("socket timed out — handler never ended the response")));
  });

const status = (res: string): string => res.split("\r\n")[0] ?? "";
const header = (res: string, name: string): string | undefined =>
  res
    .split("\r\n\r\n")[0]
    ?.split("\r\n")
    .slice(1)
    .find((h) => h.toLowerCase().startsWith(`${name}: `))
    ?.slice(name.length + 2);

test("an unknown path 404s even with no database configured", async () => {
  await withServer(async (port) => {
    for (const path of ["/admin", "/incidents/abc", "/../etc/passwd"]) {
      const res = await raw(port, `GET ${path} HTTP/1.1`, authed);
      assert.match(status(res), /^HTTP\/1\.1 404\b/, `${path} should 404`);
    }
  });
});

test("anything but GET is refused — the dashboard is read-only by contract", async () => {
  await withServer(async (port) => {
    for (const verb of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await raw(port, `${verb} /incidents HTTP/1.1`, authed);
      assert.match(status(res), /^HTTP\/1\.1 405\b/, `${verb} should 405`);
    }
    // The two session routes each answer their own verbs and nothing more.
    assert.match(status(await raw(port, "PUT /login HTTP/1.1")), /^HTTP\/1\.1 405\b/);
    assert.match(status(await raw(port, "GET /logout HTTP/1.1", authed)), /^HTTP\/1\.1 405\b/);
    // Refused before the session is even looked at: a stranger POSTing to a page gets the
    // same answer as an operator, and neither learns anything from it.
    const res = await raw(port, "POST /incidents HTTP/1.1");
    assert.match(status(res), /^HTTP\/1\.1 405\b/);
    assert.equal(header(res, "allow"), "GET");
  });
});

// Every page but /topology runs no JavaScript at all, so declaring that in a header turns a
// future missed esc() from an exploit into inert text. These are the pages that render LLM
// output and Alertmanager labels, which is why the exemption below stops short of them.
test("responses carry a no-JS CSP and nosniff", async () => {
  await withServer(async (port) => {
    for (const path of ["/", "/incidents", "/incidents/42", "/login"]) {
      const res = await raw(port, `GET ${path} HTTP/1.1`, authed);
      assert.match(
        res,
        /content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'/i,
        `${path} should carry the script-free policy`
      );
      // Split at the header boundary. Asserting over the WHOLE response made the test
      // constrain prose: the stylesheet is inlined into every page, and a CSS comment
      // explaining why the drawer cannot use a script mentioned the directive by name and
      // failed this. The header is what carries the policy, so the header is what is checked —
      // and the body gets the stronger assertion the old one never made, that no page which
      // claims a script-free policy actually ships a script.
      const [head, body = ""] = res.split("\r\n\r\n");
      assert.doesNotMatch(head, /script-src/i, `${path} needs no script-src at all`);
      assert.doesNotMatch(body, /<script/i, `${path} declares no script-src but ships a script`);
    }
    assert.match(await raw(port, "GET / HTTP/1.1", authed), /x-content-type-options: nosniff/i);
  });
});

// The one exemption, and the two things that keep it narrow: the nonce is fresh per response,
// and it is the ONLY thing script-src names. 'unsafe-inline' anywhere in this header would hand
// the exemption to an injected <script> as well.
//
// Two tags now rather than one — the JSON data block and the React Flow bundle — and the
// assertion is over ALL of them: a tag the header does not cover is a tag the browser refuses,
// which on this page is an interactive map that silently is not one.
test("/topology allows scripts only by nonce, minted per response", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "GET /topology HTTP/1.1", authed);
    const csp = header(res, "content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([\w-]+)'/.exec(csp)?.[1];
    assert.ok(nonce, `no nonce in the policy: ${csp}`);
    assert.ok(nonce.length >= 20, "a guessable nonce is 'unsafe-inline' with extra steps");
    assert.doesNotMatch(csp, /unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/i);

    // Every script tag, not just the first: the header and the markup have to name the same
    // value or the tag never runs.
    const tags = [...res.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(tags.length > 0, "the topology page should ship its map");
    for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), `unnonced script: ${tag}`);

    const again = await raw(port, "GET /topology HTTP/1.1", authed);
    const nonce2 = /script-src 'nonce-([\w-]+)'/.exec(header(again, "content-security-policy") ?? "")?.[1];
    assert.notEqual(nonce2, nonce, "a reused nonce is a nonce an attacker can wait for");
  });
});

// style-src gains 'self' on this page and NOWHERE else. The map links React Flow's stylesheet,
// and widening the policy for every other page would give an injected <link> somewhere to
// point — on the pages that render LLM output, which is the whole reason those pages have no
// script-src either.
test("only /topology may load an external stylesheet", async () => {
  await withServer(async (port) => {
    const map = header(await raw(port, "GET /topology HTTP/1.1", authed), "content-security-policy") ?? "";
    assert.match(map, /style-src 'self' 'unsafe-inline'/);

    for (const path of ["/", "/incidents", "/context"]) {
      const csp = header(await raw(port, `GET ${path} HTTP/1.1`, authed), "content-security-policy") ?? "";
      assert.match(csp, /style-src 'unsafe-inline';/, `${path} should not widen style-src`);
      assert.doesNotMatch(csp, /style-src[^;]*'self'/, `${path} needs no external stylesheet`);
    }
  });
});

// The dashboard's only static assets. Content-addressed, so this is the one response here that
// is cacheable at all — and the one place `no-store` is deliberately overridden.
test("the client bundle is served, immutable, and only at the hash it was built with", async () => {
  await withServer(async (port) => {
    const page = await raw(port, "GET /topology HTTP/1.1", authed);
    const src = /<script src="([^"]+)"/.exec(page)?.[1];
    // Skipped rather than failed when the bundle is absent: `npm test` does not build it, and a
    // suite that fails on a missing artifact would be reporting on the build, not on this code.
    if (!src) return;

    const asset = await raw(port, `GET ${src} HTTP/1.1`, authed);
    assert.match(asset, /^HTTP\/1\.1 200/);
    assert.match(header(asset, "content-type") ?? "", /text\/javascript/);
    assert.match(header(asset, "cache-control") ?? "", /immutable/);
    assert.match(header(asset, "x-content-type-options") ?? "", /nosniff/);

    // The path is a key into a Map of two files read at boot, never a filesystem lookup — so
    // there is no traversal to defend against and an unknown key is an ordinary 404.
    assert.match(await raw(port, "GET /assets/nope.js HTTP/1.1", authed), /^HTTP\/1\.1 404/);
    assert.match(
      await raw(port, "GET /assets/../../package.json HTTP/1.1", authed),
      /^HTTP\/1\.1 (404|400)/
    );
  });
});

// A bad port used to throw ERR_SOCKET_BAD_PORT synchronously out of listen(), rejecting
// start() and taking the pod down through main()'s catch — the exact outcome the dashboard
// is exempted from causing. Config now clamps it, and start() survives one anyway.
test("start() never rejects, even handed a port that cannot be listened on", async () => {
  const saved = dashboardConfig.port;
  dashboardConfig.enabled = true;
  dashboardConfig.port = 99999; // out of range: listen() throws synchronously
  const dashboard = new DashboardServer(new DashboardQueries(null));
  await assert.doesNotReject(() => dashboard.start());
  await assert.doesNotReject(() => dashboard.stop());
  dashboardConfig.port = saved;
});

test("matchRoute recognises the topology page", () => {
  assert.deepEqual(matchRoute("/topology"), { kind: "topology" });
  assert.deepEqual(matchRoute("/topology/"), { kind: "topology" });
});

// The point of this page is that it works while the database is down — that is when someone
// is most likely to open it.
test("/topology renders with no database configured", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "GET /topology HTTP/1.1", authed);
    assert.match(status(res), /^HTTP\/1\.1 200\b/);
    assert.match(res, /Dependency map/);
  });
});

// ---------- the session gate ----------

test("every page needs a session, and says where to get one", async () => {
  await withServer(async (port) => {
    for (const path of ["/", "/incidents", "/topology", "/incidents/42", "/admin"]) {
      const res = await raw(port, `GET ${path} HTTP/1.1`);
      assert.match(status(res), /^HTTP\/1\.1 303\b/, `${path} should redirect`);
      assert.match(header(res, "location") ?? "", /^\/login\?next=/, `${path} should point at /login`);
      // The 404 for /admin is deliberately NOT reached: an unauthenticated caller learns
      // nothing about which paths this server does and does not serve.
      assert.doesNotMatch(res, /Dependency map|No such page/);
    }
  });
});

test("the probe stays open — a dashboard secret must not decide whether the pod is Ready", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "GET /healthz HTTP/1.1");
    assert.match(status(res), /^HTTP\/1\.1 200\b/);
    assert.match(res, /\r\nok\r\n/); // chunked, so the body is framed rather than trailing
  });
  // and still open when the dashboard is unconfigured, which is when the 503 below applies
  await withServer(async (port) => {
    assert.match(status(await raw(port, "GET /healthz HTTP/1.1")), /^HTTP\/1\.1 200\b/);
  }, { unconfigured: true });
});

// Fail closed. The failure mode this rules out is the one that matters: a Secret that did not
// make it into the pod turning the incident history into an anonymous read.
test("with no password configured the dashboard serves 503, never content", async () => {
  await withServer(async (port) => {
    for (const path of ["/", "/incidents", "/topology", "/login"]) {
      const res = await raw(port, `GET ${path} HTTP/1.1`, authed);
      assert.match(status(res), /^HTTP\/1\.1 503\b/, `${path} should 503`);
      assert.match(res, /DASHBOARD_PASSWORD is not set/);
    }
    const posted = await raw(port, "POST /login HTTP/1.1", { body: "password=anything" });
    assert.match(status(posted), /^HTTP\/1\.1 503\b/);
  }, { unconfigured: true });
});

test("signing in sets an HttpOnly cookie and lands on the page you asked for", async () => {
  await withServer(async (port) => {
    const form = await raw(port, "GET /login HTTP/1.1");
    assert.match(status(form), /^HTTP\/1\.1 200\b/);
    assert.match(form, /name="password"/);

    const res = await raw(port, "POST /login HTTP/1.1", {
      body: `password=${encodeURIComponent(PASSWORD)}&next=%2Fincidents`,
    });
    assert.match(status(res), /^HTTP\/1\.1 303\b/);
    assert.equal(header(res, "location"), "/incidents");
    const cookie = header(res, "set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=v1\\.\\d+\\.`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);

    // and the cookie it just issued actually opens the door
    const token = cookie.slice(SESSION_COOKIE.length + 1).split(";")[0];
    const page = await raw(port, "GET /topology HTTP/1.1", { headers: [`Cookie: ${SESSION_COOKIE}=${token}`] });
    assert.match(status(page), /^HTTP\/1\.1 200\b/);
  });
});

test("a wrong password gets the form back with an error and no cookie", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "POST /login HTTP/1.1", { body: "password=wrong" });
    assert.match(status(res), /^HTTP\/1\.1 401\b/);
    assert.equal(header(res, "set-cookie"), undefined);
    assert.match(res, /That password is not right/);
  });
});

test("a forged or expired cookie is no better than none", async () => {
  await withServer(async (port) => {
    const forged = [
      mintSession("not the password"),
      mintSession(PASSWORD, Date.now() - 25 * 60 * 60 * 1000), // issued yesterday, long expired
      `v1.${Date.now() + 60_000}.notasignature`,
      "v1.9999999999999.x",
      "garbage",
    ];
    for (const token of forged) {
      const res = await raw(port, "GET /topology HTTP/1.1", { headers: [`Cookie: ${SESSION_COOKIE}=${token}`] });
      assert.match(status(res), /^HTTP\/1\.1 303\b/, `token ${token.slice(0, 24)} got in`);
    }
  });
});

test("signing out clears the cookie", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "POST /logout HTTP/1.1", authed);
    assert.match(status(res), /^HTTP\/1\.1 303\b/);
    assert.equal(header(res, "location"), "/login");
    assert.match(header(res, "set-cookie") ?? "", /Max-Age=0/);
  });
});

// A single shared password is a guessable secret; without this it is guessable at line rate.
test("repeated wrong passwords are throttled, with a Retry-After", async () => {
  await withServer(async (port) => {
    let last = "";
    for (let i = 0; i < 11; i++) last = await raw(port, "POST /login HTTP/1.1", { body: "password=wrong" });
    assert.match(status(last), /^HTTP\/1\.1 429\b/);
    assert.match(header(last, "retry-after") ?? "", /^\d+$/);
    assert.match(last, /Too many sign-in attempts/);
    // Blocked means blocked: the correct password does not slip past the throttle either,
    // or an attacker gets unlimited guesses for the price of one lucky one.
    const right = await raw(port, "POST /login HTTP/1.1", { body: `password=${encodeURIComponent(PASSWORD)}` });
    assert.match(status(right), /^HTTP\/1\.1 429\b/);
  });
});

// `next` arrives from a URL anyone can put in front of an operator, and it ends up in a
// Location header. Off-origin values must not survive the round trip.
test("the post-login redirect cannot be pointed off this origin", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "POST /login HTTP/1.1", {
      body: `password=${encodeURIComponent(PASSWORD)}&next=${encodeURIComponent("//evil.example.com/")}`,
    });
    assert.match(status(res), /^HTTP\/1\.1 303\b/);
    assert.equal(header(res, "location"), "/");

    // and the form does not echo one back into its own hidden field either
    const form = await raw(port, `GET /login?next=${encodeURIComponent("https://evil.example.com")} HTTP/1.1`);
    assert.doesNotMatch(form, /evil\.example\.com/);
  });
});

test("an oversized login body is refused rather than read", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "POST /login HTTP/1.1", { body: `password=${"x".repeat(9000)}` });
    assert.match(status(res), /^HTTP\/1\.1 400\b/);
    assert.equal(header(res, "set-cookie"), undefined);
  });
});

test("/context is a route, and a trailing slash is the same route", () => {
  assert.deepEqual(matchRoute("/context"), { kind: "context" });
  assert.deepEqual(matchRoute("/context/"), { kind: "context" });
});

// The name is carried through decoded, and whether it EXISTS is the handler's question — the
// router owns no copy of the loader's NAME_RE, so a name this pattern accepts and the loader
// would reject is a 404 from the lookup rather than a second rule to keep in step.
test("/context/<name> is a skill route, decoded, and one segment deep", () => {
  assert.deepEqual(matchRoute("/context/oomkilled"), { kind: "skill", name: "oomkilled" });
  assert.deepEqual(matchRoute("/context/oomkilled/"), { kind: "skill", name: "oomkilled" });
  assert.deepEqual(matchRoute("/context/rca%20format"), { kind: "skill", name: "rca format" });
  assert.deepEqual(matchRoute("/context/a/b"), { kind: "notfound" });
  // decodeURIComponent throws on a lone %, which is a bad path and not a bad server
  assert.deepEqual(matchRoute("/context/%zz"), { kind: "notfound" });
  // capped before decoding, so a megabyte of path is never compared against anything
  assert.deepEqual(matchRoute(`/context/${"x".repeat(129)}`), { kind: "notfound" });
});

// These servers run with no database (DashboardQueries(null)), which is the point: a skill is
// read out of the running process, so its page must answer on the /context side of the DB gate
// rather than falling through to "No database configured".
test("a skill page serves from the loaded skills while the database is down", async () => {
  const skills: SkillView[] = [
    { name: "oomkilled", description: "a container at its memory limit", when: "oomkill", chars: 21, body: "1. k8s_describe_pod" },
  ];
  await withServer(async (port) => {
    const res = await raw(port, "GET /context/oomkilled HTTP/1.1", authed);
    assert.match(status(res), /^HTTP\/1\.1 200\b/);
    assert.match(res, /1\. k8s_describe_pod/);
    assert.doesNotMatch(res, /No database configured/);

    const missing = await raw(port, "GET /context/nosuchskill HTTP/1.1", authed);
    assert.match(status(missing), /^HTTP\/1\.1 404\b/);

    // and it is behind the password like every other page
    const anon = await raw(port, "GET /context/oomkilled HTTP/1.1");
    assert.match(status(anon), /^HTTP\/1\.1 303\b/);
  }, { skills });
});

// The read-only invariant, asserted rather than assumed. A route absent from METHODS answers 405
// to every method but GET, so the assertion is the absence: only login and logout accept anything
// else, and both act on the session rather than on data. Asserted against the table instead of
// over a live socket — the table IS the rule, and this cannot flake on a port.
test("only the session routes accept a non-GET method", () => {
  assert.deepEqual(Object.keys(METHODS).sort(), ["login", "logout"]);
  assert.equal("context" in METHODS, false);
});

// The prompt is read out of the running process, so this page answers while Postgres is down —
// which is one of the times someone most wants to know what the agent is being told.
test("/prompt renders the core prompt and needs no database", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "GET /prompt HTTP/1.1", authed);
    assert.match(res, /^HTTP\/1\.1 200/);
    assert.match(res, /prompts\/system\.md/);
    assert.match(res, /class="skill-body"/);
  });
});

test("/prompt is behind the password like every other page", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "GET /prompt HTTP/1.1");
    assert.match(res, /^HTTP\/1\.1 30[23]/, "an unauthenticated read must redirect to sign-in");
  });
});

// It carried the badge on every page but this one: /context was the single render path that
// never asked for the count. A page-by-page argument is a page-by-page chance to forget one.
test("/context carries the rail badge like every other page", async () => {
  await withServer(async (port) => {
    for (const path of ["/context", "/prompt", "/topology"]) {
      const res = await raw(port, `GET ${path} HTTP/1.1`, authed);
      assert.match(res, /^HTTP\/1\.1 200/, `${path} did not render`);
      // no database in these tests, so openCount is undefined and no badge is drawn — what is
      // asserted is that the page went through the chrome that would draw one
      assert.match(res, /<header class="rail">/, `${path} rendered without the rail`);
    }
  });
});
