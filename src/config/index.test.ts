import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardPort, DASHBOARD_PORT_DEFAULT } from "./index.js";

// `parseInt(x ?? "3001")` guarded only the UNSET case. Everything below survived it and then
// made http.Server.listen() throw ERR_SOCKET_BAD_PORT synchronously, which rejected start()
// and exited the pod — over a statistics page the design explicitly exempts from doing that.
test("dashboardPort falls back on anything that is not a usable port", () => {
  for (const bad of ["", "   ", "notaport", "99999", "-1", "0", "3001.5", "3001abc", "NaN"]) {
    assert.equal(dashboardPort(bad), DASHBOARD_PORT_DEFAULT, `"${bad}" should fall back`);
  }
});

test("dashboardPort accepts a real port, and unset means the default", () => {
  assert.equal(dashboardPort("3001"), 3001);
  assert.equal(dashboardPort(" 8080 "), 8080);
  assert.equal(dashboardPort("1"), 1);
  assert.equal(dashboardPort("65535"), 65535);
  assert.equal(dashboardPort(undefined), DASHBOARD_PORT_DEFAULT);
});
