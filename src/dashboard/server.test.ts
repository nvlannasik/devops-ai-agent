import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { DashboardServer, matchRoute } from "./server.js";
import { DashboardQueries } from "./queries.js";
import { config } from "../config/index.js";

test("matchRoute recognises the three pages and the probe", () => {
  assert.deepEqual(matchRoute("/"), { kind: "overview" });
  assert.deepEqual(matchRoute("/incidents"), { kind: "list" });
  assert.deepEqual(matchRoute("/healthz"), { kind: "health" });
  assert.deepEqual(matchRoute("/incidents/42"), { kind: "detail", id: 42 });
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
  // config is `as const` for the TYPE system only — nothing freezes it at runtime — so the
  // dashboard can be turned on for this one isolated test-file process (node:test's default
  // isolation is one child process per file) without an env var set before the static
  // imports above already evaluated config with DASHBOARD_ENABLED unset.
  const dashboardConfig = config.dashboard as unknown as { enabled: boolean; port: number };
  dashboardConfig.enabled = true;
  dashboardConfig.port = 0; // OS-assigned free port, avoids clashing with a fixed port

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
async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const dashboardConfig = config.dashboard as unknown as { enabled: boolean; port: number };
  dashboardConfig.enabled = true;
  dashboardConfig.port = 0;
  const dashboard = new DashboardServer(new DashboardQueries(null));
  await dashboard.start();
  const address = (dashboard as unknown as { server: { address(): net.AddressInfo } }).server.address();
  try {
    return await fn(address.port);
  } finally {
    await dashboard.stop();
  }
}

const raw = (port: number, requestLine: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
    sock.setTimeout(5000, () => reject(new Error("socket timed out — handler never ended the response")));
  });

test("an unknown path 404s even with no database configured", async () => {
  await withServer(async (port) => {
    for (const path of ["/admin", "/incidents/abc", "/../etc/passwd"]) {
      const res = await raw(port, `GET ${path} HTTP/1.1`);
      assert.match(res.split("\r\n")[0] ?? "", /^HTTP\/1\.1 404\b/, `${path} should 404`);
    }
  });
});

test("anything but GET is refused — the dashboard is read-only by contract", async () => {
  await withServer(async (port) => {
    for (const verb of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await raw(port, `${verb} /incidents HTTP/1.1`);
      assert.match(res.split("\r\n")[0] ?? "", /^HTTP\/1\.1 405\b/, `${verb} should 405`);
    }
  });
});

// The pages run no JavaScript at all, so declaring that in a header turns a future missed
// esc() from an exploit into inert text.
test("responses carry a no-JS CSP and nosniff", async () => {
  await withServer(async (port) => {
    const res = await raw(port, "GET / HTTP/1.1");
    assert.match(res, /content-security-policy: default-src 'none'; style-src 'unsafe-inline'/i);
    assert.match(res, /x-content-type-options: nosniff/i);
  });
});

// A bad port used to throw ERR_SOCKET_BAD_PORT synchronously out of listen(), rejecting
// start() and taking the pod down through main()'s catch — the exact outcome the dashboard
// is exempted from causing. Config now clamps it, and start() survives one anyway.
test("start() never rejects, even handed a port that cannot be listened on", async () => {
  const dashboardConfig = config.dashboard as unknown as { enabled: boolean; port: number };
  const saved = dashboardConfig.port;
  dashboardConfig.enabled = true;
  dashboardConfig.port = 99999; // out of range: listen() throws synchronously
  const dashboard = new DashboardServer(new DashboardQueries(null));
  await assert.doesNotReject(() => dashboard.start());
  await assert.doesNotReject(() => dashboard.stop());
  dashboardConfig.port = saved;
});
