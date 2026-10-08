import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSilence, openSilence } from "./silence.js";

// Every case injects a real fault, the dev cluster's alert rules have no namespace selector, and
// so without a silence each one pages the PRODUCTION agent: a real investigation in the real
// Slack channel and a real incident row (2026-10-08: incidents 240/242/244 from one bench run).

test("the silence matches the bench namespaces and nothing wider, for a bounded time, via amtool in the pod", () => {
  const calls: string[][] = [];
  const id = openSilence(90 * 60_000, (args) => {
    calls.push(args);
    return "c737187d-5fe4-4fb2-b223-eb47ae13f906\n";
  });
  assert.equal(id, "c737187d-5fe4-4fb2-b223-eb47ae13f906");
  const a = calls[0]!;
  assert.deepEqual(a.slice(0, 4), ["-n", "monitoring", "exec", "svc/alertmanager"]);
  assert.deepEqual(a.slice(5, 9), ["amtool", "silence", "add", "namespace=~bench-.*"]);
  assert.ok(a.includes("--duration=90m"), a.join(" "));
  assert.ok(a.includes("--alertmanager.url=http://localhost:9093"), a.join(" "));
  assert.equal(a.filter((x) => /=~|=/.test(x) && !x.startsWith("--")).length, 1, "exactly one matcher — never wider than bench-*");
});

test("a silence that cannot be opened stops the run before any fault is injected", () => {
  assert.throws(
    () => openSilence(60_000, () => { throw new Error('services "alertmanager" not found'); }),
    /BENCH_SILENCE=false/
  );
  assert.throws(() => openSilence(60_000, () => "\n"), /BENCH_SILENCE=false/);
});

test("closing expires that silence and never throws", () => {
  const calls: string[][] = [];
  closeSilence("abc", (args) => { calls.push(args); return ""; });
  assert.deepEqual(calls[0]!.slice(-5), ["amtool", "silence", "expire", "--alertmanager.url=http://localhost:9093", "abc"]);
  assert.doesNotThrow(() => closeSilence("abc", () => { throw new Error("gone"); }));
});
