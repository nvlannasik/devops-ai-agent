import type { Message } from "../llm/types.js";

/**
 * Evidence grounding: which resource names an answer asserts that no tool result ever showed.
 *
 * The failure this exists for: an investigation found a Service `order-services-svc` with no
 * ready endpoints, then named a Deployment `order-service` behind it — a name it derived from
 * the Service's, and that no tool ever returned. The remediation dry-run caught the proposal
 * (`deployments.apps "order-service" not found`), but the RCA carried the invented name into
 * Slack unchallenged, into `incidents.root_cause`, and back out as recall context for the next
 * investigation. The dry-run guards the action; nothing guarded the claim.
 *
 * Deliberately deterministic. The model is what invented the name, so asking it to check its own
 * work is asking the wrong witness — and MEMORY_BANK has the same finding for every other guard
 * in this loop.
 */

// The RCA format mandates inline code for resource names (prompts/skills/rca-format.md), so the
// backticks are the model's own marking of "this is a name", not a heuristic we imposed.
const BACKTICKED = /`([^`\n]{1,120})`/g;

// DNS-1123-ish, optionally namespace-qualified: what a Kubernetes object can actually be called.
// Everything else in backticks is something we must NOT check — PromQL (`sum(rate(...))`),
// metric names (underscores), label selectors (`app=nginx`), quantities (`512Mi`, `98%`),
// timestamps and reason strings (`CrashLoopBackOff`) all fail this on a character they contain.
const K8S_NAME = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)?$/;

const MIN_LENGTH = 4;

/**
 * A bare word is not checkable: `storefront` or `pending` would be flagged on a wording
 * difference rather than an invented resource, and generic words appear in tool output anyway.
 * Requiring a separator keeps this to things shaped like an identifier.
 *
 * The three-letter run is what keeps DURATIONS out. K8S_NAME rejects `512Mi` on its capital and
 * `98%` on its percent, but a lowercase quantity has nothing to trip on: `1.5s` starts with a
 * digit, contains a dot and a letter, and sails through every rule above it. Observed on
 * 2026-09-03 — an RCA quoting a p99 of `1.5s` was reported to the on-call thread as naming a
 * resource no tool had returned. Every workload name in this system carries a word
 * (`storefront`, `orders-api`, `checkout-gateway`); `30s`, `2m30s`, `100m` and `v1.2.3` do not.
 *
 * Deliberately biased towards missing an invention rather than inventing one. This posts an
 * unsolicited warning into an incident thread that nobody can silence, so a false positive
 * costs more than a false negative — the write-tool filter and the dry-run are the guards that
 * actually stop a bad action, not this.
 */
const looksLikeIdentifier = (name: string): boolean =>
  name.length >= MIN_LENGTH && /[a-z]{3}/.test(name) && /[-./]/.test(name);

/** Names the answer asserts, namespace-qualified ones split into their parts. */
export function citedNames(answer: string): string[] {
  const out = new Set<string>();
  for (const [, inner] of answer.matchAll(BACKTICKED)) {
    const token = inner!.trim();
    if (!K8S_NAME.test(token)) continue;
    // `sample-apps/orders-api` is two claims: tool output names the namespace and the workload
    // separately, so checking the joined string would flag every correctly-cited resource.
    //
    // ponytail: names, not pairs — a workload seen in namespace A grounds a claim about
    // namespace B. Real here: `default/order-services-svc` is an orphaned Service whose selector
    // matches labels that only exist on `sample-apps/orders-api`, so both halves of a wrong pair
    // are individually true. Pairing needs the namespace and the name to co-occur in one tool
    // result, which their formats do not agree on; add it when a wrong pair is actually observed.
    for (const part of token.split("/")) {
      if (looksLikeIdentifier(part)) out.add(part);
    }
  }
  return [...out];
}

/**
 * What the investigation actually went and looked at: every tool RESULT, plus every tool
 * ARGUMENT.
 *
 * The arguments were not counted at first, and the check's very first real firing was a false
 * positive because of it — `sample-apps` flagged in an RCA whose only tool calls were
 * `k8s_list_events{namespace: "sample-apps"}` and a Prometheus query that came back empty. A tool
 * scoped to a namespace routinely does not repeat that namespace in its body, so nearly every RCA
 * naming its own namespace was going to be flagged, and a check that cries wolf is a check nobody
 * reads by the second week.
 *
 * Counting arguments is weaker but still catches the failure this exists for: `order-service` was
 * derived from a Service's name and asserted in prose, and it was never passed to any tool. What
 * this can no longer catch is a name the model invents AND then queries — and that query's empty
 * result is visible on its own.
 *
 * Assistant TEXT is still excluded, and that line matters: prose is where the invention lands, so
 * letting it count would let one hallucination confirm the next. The alert message is excluded for
 * the same reason — the recall block it carries is a past incident's root_cause, which is exactly
 * how an invented name propagates forward.
 */
export function observedText(history: Message[]): string {
  const parts: string[] = [];
  for (const m of history) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_result" && typeof block.content === "string") parts.push(block.content);
      if (block.type === "tool_use" && block.input) parts.push(JSON.stringify(block.input));
    }
  }
  return parts.join("\n").toLowerCase();
}

/**
 * Grounded means the name appears in tool output as its own identifier, and the boundaries are
 * what make this usable rather than noisy:
 *
 * - a trailing `-` IS allowed, because that is how Kubernetes names a workload's pods —
 *   `checkout-gateway` is only ever seen as `checkout-gateway-6b747db7c9-zwdcv`, and demanding
 *   an exact token would flag every correctly-named Deployment in every RCA;
 * - a trailing letter or digit is NOT, which is the whole point: `order-service` sits inside
 *   `order-services-svc` as a plain prefix, and a substring test would have called the invented
 *   name grounded by the very Service it was invented from.
 */
const isGrounded = (name: string, observed: string): boolean =>
  new RegExp(`(?<![a-z0-9.-])${name.replace(/[.]/g, "\\.")}(?![a-z0-9.])`).test(observed);

/** Names asserted in `answer` that no tool result in `history` ever returned, in cited order. */
export function groundingGaps(answer: string, history: Message[]): string[] {
  const names = citedNames(answer);
  if (names.length === 0) return [];
  const observed = observedText(history);
  return names.filter((n) => !isGrounded(n, observed));
}
