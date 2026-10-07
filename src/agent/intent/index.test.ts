import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsInvestigation, wantsTour, mentionBudget } from "./index.js";

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

test("tour questions are detected (en + id) and need explain vocabulary plus a subject", () => {
  for (const t of ["jelasin cluster ini dong", "jelaskan workload di namespace sample-apps", "workload apa aja yang jalan di cluster?",
                   "explain this cluster to me, I just joined", "give me an overview of the namespaces", "onboarding cluster dong",
                   "gambaran namespace devops-tools"]) assert.equal(wantsTour(t), true, t);
  for (const t of ["check status semua pod di devops-tools", "halo, kamu bisa apa?", "jelasin dong"]) assert.equal(wantsTour(t), false, t);
});

test("a tour sentence that asks why is an investigation, not a tour", () => {
  assert.equal(wantsTour("jelasin kenapa storefront crash di sample-apps"), false);
  assert.deepEqual(mentionBudget("jelasin kenapa storefront crash di sample-apps", { mention: 2, tour: 4 }), {});
});

test("one budget for every caller: investigation unlimited, tour its own, the rest the mention cap", () => {
  const r = { mention: 2, tour: 4 };
  assert.deepEqual(mentionBudget("investigate the 5xx spike", r), {});
  assert.deepEqual(mentionBudget("jelasin cluster ini", r), { maxToolRounds: 4 });
  assert.deepEqual(mentionBudget("show me services in monitoring", r), { maxToolRounds: 2 });
});
