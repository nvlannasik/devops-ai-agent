/**
 * A proposal has a premise. This checks the cluster ever stated it.
 *
 * `k8s_set_resources` says the fault is a resource one, and the proposal prompt already names the
 * only two ways that can be true: a container the kernel killed for memory, or a pod the scheduler
 * could not fit because its REQUEST is larger than any node. Both leave a mark in the namespace's
 * events — `OOMKilling`, `FailedScheduling ... Insufficient cpu` — and neither can be inferred
 * from a pod that simply keeps exiting.
 *
 * Benchmark C03 is why this exists: a container that runs `sleep 3; exit 1` and prints nothing.
 * The right answer is that the evidence is missing and there is no action. Two attempts out of
 * three instead proposed a memory limit, reasoning from `+Inf` — the memory-ratio metric of a
 * pod with NO limit set, which is a description of the spec rather than a symptom. A human would
 * have been asked to approve a limit against a crash the limit has nothing to do with.
 *
 * Same instrument as `replace-guard.ts` and for the same reason: the prompt says this and the
 * prompt does not hold. Different question, though — that one asks whether the ACTION can reach
 * the fault, this one asks whether the fault is the kind the action names.
 */

/**
 * What a resource fault leaves behind, in the words Kubernetes itself writes.
 *
 * Deliberately wider than OOM alone: CPU throttling and eviction under node pressure are resource
 * exhaustion too, and an operator reading `Evicted` would reach for the same action. `137` is
 * matched only as `exit code 137` — the bare number appears in port numbers and byte counts.
 */
export const RESOURCE_EVIDENCE =
  /oomkill\w*|out of memory|exit code 137|insufficient (cpu|memory|ephemeral-storage)|\bevicted\b|(memory|disk) pressure|throttl\w*|exceeded its (memory|cpu)/i;

/**
 * Why this proposal must not become a card, or null to let it through.
 *
 * `observed` is raw tool output — events, pod descriptions — never the model's own text. An RCA
 * that invented a resource theory would state it in prose too, so reading the answer back to
 * itself would confirm every invention. The same rule `agent/grounding/` follows.
 *
 * Fails open on an EMPTY `observed`: nothing came back, so nothing is proven absent. That is the
 * "empty result = evidence of absence for the query you ran" rule from `prompts/system.md`,
 * applied to ourselves — a refusal built on a failed tool call is a guess wearing a guard's
 * clothes.
 */
export function resourceEvidenceRefusal(action: string, observed: string): string | null {
  if (action !== "k8s_set_resources") return null;
  if (!observed.trim()) return null;
  if (RESOURCE_EVIDENCE.test(observed)) return null;
  return (
    `changing the resource requests or limits says the fault is a resource one, and nothing in the ` +
    `namespace's events says it is: no OOMKill, no eviction, no throttling, and no scheduler message ` +
    `about an unsatisfiable request. A container that keeps exiting on its own is exiting for a reason ` +
    `of its own — a missing config key, a failed dependency, a bad command — and a memory or CPU number ` +
    `does not reach any of those. A pod with no limit set reports an infinite memory ratio; that is a ` +
    `description of the spec, not a symptom.`
  );
}
