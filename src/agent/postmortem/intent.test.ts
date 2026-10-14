import { test } from "node:test";
import assert from "node:assert/strict";
import { postmortemIntent } from "./intent.js";

test("asks for a postmortem, in English and Indonesian", () => {
  for (const t of ["postmortem", "write a postmortem for this", "post-mortem please", "incident review", "bikin postmortem dong", "buat post-mortem untuk insiden ini"]) assert.equal(postmortemIntent(t), "postmortem", t);
});
test("a deferral or refusal is declined", () => {
  for (const t of ["postmortem nanti aja", "jangan bikin postmortem dulu", "no postmortem needed", "skip the postmortem", "postmortem later"]) assert.equal(postmortemIntent(t), "declined", t);
});
test("a negated phrase around postmortem is not a decline", () => {
  for (const t of ["jangan lupa bikin postmortem dong", "don't forget the postmortem", "don't skip the root cause section in the postmortem"]) assert.equal(postmortemIntent(t), "postmortem", t);
});
test("an unrelated mention is not a postmortem request", () => {
  for (const t of ["why is checkout slow?", "learn", "restart orders-api", "resolved"]) assert.equal(postmortemIntent(t), null, t);
});
