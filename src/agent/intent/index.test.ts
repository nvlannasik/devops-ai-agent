import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsInvestigation } from "./index.js";

test("explicit investigation requests are detected (en + id)", () => {
  assert.equal(wantsInvestigation("pods in payment are crashing, investigate this"), true);
  assert.equal(wantsInvestigation("tolong investigasi kenapa pod restart terus"), true);
  assert.equal(wantsInvestigation("selidiki error di nginx"), true);
  assert.equal(wantsInvestigation("what's the root cause of the 5xx spike?"), true);
  assert.equal(wantsInvestigation("kasih RCA buat incident tadi"), true);
  assert.equal(wantsInvestigation("kenapa latency naik?"), true);
  assert.equal(wantsInvestigation("why is the pod pending?"), true);
});

test("plain data requests are not investigations", () => {
  assert.equal(wantsInvestigation("coba liat log deployment nginx di namespaces nginx-ingress"), false);
  assert.equal(wantsInvestigation("check status semua pod di devops-tools"), false);
  assert.equal(wantsInvestigation("show me services in monitoring"), false);
  assert.equal(wantsInvestigation("halo, kamu bisa apa?"), false);
});
