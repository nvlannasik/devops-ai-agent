import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_DEADLINE_RESERVE_MS,
  delegationHint,
  offersDelegation,
  DELEGATE_MARKER,
  DELEGATE_TOOL,
  capFanout,
  childDeadline,
  hypothesisOf,
  subThreadId,
  withDelegateTool,
  type SubagentConfig,
} from "./index.js";
import type { ContentBlock, ToolDefinition } from "../llm/types.js";

const cfg = (over: Partial<SubagentConfig> = {}): SubagentConfig => ({
  enabled: true,
  maxFanout: 3,
  toolRounds: 3,
  maxIterations: 5,
  ...over,
});

const mcpTools: ToolDefinition[] = [
  { name: "k8s_list_pods", description: "list pods", inputSchema: {} },
  { name: "loki_query", description: "query logs", inputSchema: {} },
];

const delegate = (hypothesis?: unknown, id = "t1"): ContentBlock =>
  ({ type: "tool_use", id, name: DELEGATE_TOOL, ...(hypothesis === undefined ? {} : { input: { hypothesis } }) }) as ContentBlock;

// An alert investigation, and an explicit "investigate this" mention: no tool budget, several
// candidate causes, an RCA at the end. The only shape delegation is for.
const lead = { depth: 0, maxToolRounds: Infinity };
// A plain mention. MENTION_TOOL_ROUNDS is 2, so one delegate would spend half the rounds the
// whole question gets, and 60s of the parent's clock with them.
const conversation = { depth: 0, maxToolRounds: 2 };
const delegated = { depth: 1, maxToolRounds: 3 };

// The flag's whole purpose is that OFF is today's behaviour, so it can serve as the baseline the
// ON side is measured against. A tool that is registered but refused would not be: the tools array
// is cached as one block and counts against the context budget, so its mere presence moves both.
test("OFF leaves the tools array untouched, not merely unusable", () => {
  assert.deepEqual(withDelegateTool(mcpTools, cfg({ enabled: false }), lead), mcpTools);
});

test("ON offers the delegate tool to the lead investigation", () => {
  const tools = withDelegateTool(mcpTools, cfg(), lead);
  assert.equal(tools.length, mcpTools.length + 1);
  assert.equal(tools.at(-1)!.name, DELEGATE_TOOL);
});

// The observed miss: the deployed build offered this on the mention path too, where it could
// never pay for itself — and the tool description is a token cost on every one of those calls.
test("a finite tool budget is not offered delegation at all", () => {
  assert.deepEqual(withDelegateTool(mcpTools, cfg(), conversation), mcpTools);
  assert.equal(offersDelegation(conversation), false);
  assert.equal(offersDelegation({ depth: 0, maxToolRounds: 1 }), false);
  assert.equal(offersDelegation(lead), true);
});

// Depth 1 is the whole nesting policy: a delegate that could delegate multiplies the LLM calls
// and the wall clock geometrically, inside a deadline that only shrinks. Stated independently of
// the budget clause — a delegate given an infinite budget must still not delegate.
test("a delegate is never offered the delegate tool", () => {
  assert.deepEqual(withDelegateTool(mcpTools, cfg(), delegated), mcpTools);
  assert.equal(offersDelegation({ depth: 1, maxToolRounds: Infinity }), false);
});

test("the tool description names the fan-out cap it is actually run with", () => {
  const tool = withDelegateTool(mcpTools, cfg({ maxFanout: 2 }), lead).at(-1)!;
  assert.match(tool.description, /up to 2 run in parallel/);
});

// Refused, not dropped: an unanswered tool_use is a 400 from Anthropic, so the count of results
// must equal the count of calls whatever the cap does.
test("fan-out past the cap is refused with a result per call", () => {
  const calls = [delegate("a", "1"), delegate("b", "2"), delegate("c", "3"), delegate("d", "4"), delegate("e", "5")];
  const { run, refusals } = capFanout(calls, 3);
  assert.equal(run.length, 3);
  assert.equal(refusals.length, 2);
  assert.equal(run.length + refusals.length, calls.length);
  assert.deepEqual(refusals.map((r) => r.tool_use_id), ["4", "5"]);
  for (const r of refusals) {
    assert.equal(r.type, "tool_result");
    assert.match(r.content!, /^Error: at most 3 hypotheses/);
  }
});

test("fan-out at or under the cap refuses nothing", () => {
  const { run, refusals } = capFanout([delegate("a", "1"), delegate("b", "2")], 3);
  assert.equal(run.length, 2);
  assert.deepEqual(refusals, []);
});

// The parent still has to read the findings and compose an answer. A child running to the
// parent's own deadline delivers evidence to a run that has already timed out.
test("a delegate's deadline leaves the parent time to answer in", () => {
  const parent = 1_000_000;
  assert.equal(childDeadline(parent), parent - CHILD_DEADLINE_RESERVE_MS);
  assert.ok(childDeadline(parent) < parent);
});

// Prefix, not a fresh id: grepping the Slack thread id has to keep finding every child across
// the agent log, the llm-worker log and the thread — the property utils/trace exists for.
test("a sub-thread id carries its parent's id", () => {
  assert.equal(subThreadId("1712345.6789", 1), "1712345.6789/sub-1");
  assert.ok(subThreadId("1712345.6789", 2).startsWith("1712345.6789"));
});

test("a missing or blank hypothesis reads as empty rather than as \"undefined\"", () => {
  assert.equal(hypothesisOf(delegate()), "");
  assert.equal(hypothesisOf(delegate("   ")), "");
  assert.equal(hypothesisOf(delegate("  the 14:02 rollout regressed it  ")), "the 14:02 rollout regressed it");
});

// A delegate is a new entry point, and MEMORY_BANK.md §Response Mode is explicit that every entry
// point stamps its own marker or the model defaults to the RCA format — the wrong shape for
// something whose reader is the lead investigation. Self-describing, so prompts/system.md (one
// cached block, shared with the OFF side) needs no clause.
test("the delegate marker keeps the child out of RCA format on its own", () => {
  assert.match(DELEGATE_MARKER, /do NOT use the RCA incident format/i);
  assert.match(DELEGATE_MARKER, /SUPPORTED, CONTRADICTED or UNPROVEN/);
});

// ---- The deterministic trigger ----
//
// Across three firing incidents the model had the tool, an unlimited budget and a 342-token
// prompt section, and never once reached for it — once with 388k characters of logs and two
// related alerts. So the loop names the condition instead of hoping the model spots it, and the
// condition is read off the labels rather than guessed: one rule firing for two services IS two
// candidate causes, and which reading is right is the question the investigation exists to answer.
const twoServices = { key: "service", values: ["checkout-gateway", "storefront"] };

test("a multi-subject group names the services and asks for one delegate each", () => {
  const hint = delegationHint(twoServices, cfg());
  assert.match(hint, /`checkout-gateway`, `storefront`/);
  assert.match(hint, /one `delegate_investigation` per service in your FIRST turn \(2, in parallel\)/);
});

// The value is the verdict, not the fan-out: the previous code assumed one shared root cause
// silently (correlation/index.ts's "every alert in the payload shares a root cause").
test("the hint asks for the cascade-or-separate verdict, and forbids assuming it", () => {
  const hint = delegationHint(twoServices, cfg());
  assert.match(hint, /do not assume either/);
  assert.match(hint, /one cascade or separate incidents/);
});

test("the hint never asks for more delegates than the fan-out cap allows", () => {
  const five = { key: "service", values: ["a-svc", "b-svc", "c-svc", "d-svc", "e-svc"] };
  const hint = delegationHint(five, cfg({ maxFanout: 3 }));
  assert.match(hint, /\(3, in parallel\)/);
  assert.match(hint, /and 2 more/);
  assert.equal(hint.includes("`d-svc`"), false, "named a service past the cap it cannot delegate to");
});

// Same rule as the tool and the prompt section: with the flag off the alert message is untouched,
// which is what keeps OFF the baseline ON is measured against.
test("nothing is added when delegation is not on the table", () => {
  assert.equal(delegationHint(twoServices, cfg({ enabled: false })), "");
  assert.equal(delegationHint({ key: "service", values: ["only-one"] }, cfg()), "");
  assert.equal(delegationHint(null, cfg()), "");
});

// The hint ships on the alert path, where the tool IS offered — but it must not strand the model
// if that ever stops being true.
test("the hint still works when the tool is absent", () => {
  assert.match(delegationHint(twoServices, cfg()), /not in your tool list, investigate them\s+yourself/);
});
