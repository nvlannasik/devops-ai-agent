import { test } from "node:test";
import assert from "node:assert/strict";
import { AllBackendsFailedError, classifyFailure, oneLine, userFacingError } from "./failure.js";

// The two errors every alert thread got on 2026-11-24, verbatim up to the stack.
const DEEPSEEK = "402 Insufficient Balance (request_id: 583eef7f-7d39-4a33-a477-4f58f7e4dfb9)";
const CHATGPT = "429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";
const withStack = (m: string) => Object.assign(new Error(m), { stack: `Error: ${m}\n    at APIError.generate (file:///app/node_modules/openai/error.mjs:64:16)\n    at OpenAI.makeStatusError (file:///app/node_modules/openai/core.mjs:295:25)` });

test("classifyFailure: billing wording beats the status code; a bare 429 is rate limiting", () => {
  assert.equal(classifyFailure(DEEPSEEK), "credit");
  assert.equal(classifyFailure(CHATGPT), "credit");
  assert.equal(classifyFailure("429 Too Many Requests"), "rate-limit");
  assert.equal(classifyFailure("401 Incorrect API key provided"), "auth");
  assert.equal(classifyFailure("Request timed out after 120000ms"), "timeout");
  assert.equal(classifyFailure("LLM worker error: Agent builder 502: <html>"), "unavailable");
  assert.equal(classifyFailure("something odd"), "other");
});

test("oneLine: the first line of the message, never the stack", () => {
  assert.equal(oneLine(withStack(DEEPSEEK)), DEEPSEEK);
  assert.equal(oneLine("    at x (y:1:1)\nreal line"), "real line");
  assert.ok(oneLine("x".repeat(500)).length <= 180);
});

test("both backends out of credit: which, why, that the alert still needs a person, and what to do — no stack", () => {
  const err = new AllBackendsFailedError("heavy", [
    { backend: "deepseek", kind: "credit", summary: oneLine(withStack(DEEPSEEK)) },
    { backend: "chatgpt", kind: "credit", summary: oneLine(withStack(CHATGPT)) },
  ]);
  assert.doesNotMatch(err.message, /\n\s+at\s/, "the error's own message carries no stack either");
  const t = userFacingError(err, "alert");
  assert.match(t, /^⚠️ \*I could not investigate this alert\* — every LLM backend I could use failed:/);
  assert.match(t, /• `deepseek` is out of credit — 402 Insufficient Balance/);
  assert.match(t, /• `chatgpt` is out of credit — 429 You have no credits remaining/);
  assert.match(t, /Nothing about the alert was checked, so it still needs a look by a person\./);
  assert.match(t, /Top up one of these backends, then mention me here/);
  assert.doesNotMatch(t, /error\.mjs|node_modules|\n\s+at /);
});

test("other shapes: rate limit says it passes, a mention has no alert line, an internal error is one line", () => {
  const rl = new AllBackendsFailedError("heavy", [{ backend: "chatgpt", kind: "rate-limit", summary: "429 Too Many Requests" }]);
  assert.match(userFacingError(rl, "mention"), /usually passes within minutes/);
  assert.doesNotMatch(userFacingError(rl, "mention"), /still needs a look/);
  const internal = userFacingError(withStack("MCP error -32001: Request timed out"), "alert");
  assert.match(internal, /an internal error: `MCP error -32001: Request timed out`\./);
  assert.doesNotMatch(internal, /node_modules/);
  assert.match(userFacingError(new AllBackendsFailedError("heavy", []), "postmortem"), /I could not draft the postmortem\* — no LLM backend was usable\./);
});
