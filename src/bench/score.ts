// Scoring for the incident benchmark — see bench/README.md.
//
// k8s-ai-bench scores by diffing CLUSTER STATE after the agent has acted: `verify.sh` asks
// kubectl whether the memory limit changed. That is the right shape for an agent that wields
// kubectl, and the wrong one for this agent, which by design never acts — [WRITE] tools are
// filtered out of the loop and every remediation waits on a human clicking Approve. Scored
// that way, a correct investigation and a refusal to diagnose are indistinguishable: both
// leave the cluster exactly as they found it.
//
// So we score the ARTEFACT this agent actually produces: the remediation proposal, which is
// already structured JSON validated by parseProposal(). One consequence worth stating —
// because the artefact is structured, there is ONE verifier for every task, declared in the
// task file, instead of a bash script per task.

import type { Proposal } from "../agent/remediation/proposal.js";

export interface Expectation {
  /**
   * The whitelisted action the agent should propose — or null when the correct answer is to
   * propose NOTHING. That second case is not padding: an agent that proposes a fix for a
   * healthy namespace is the failure mode this system has actually shipped, and a benchmark
   * with no negative tasks scores it perfectly.
   */
  action: string | null;
  namespace?: string;
  /** Proposal.name — the workload or pod the action targets. */
  target?: string;
  /** toolParams entries that must match exactly. Compared as strings: replicas is a number. */
  params?: Record<string, string>;
  /**
   * toolParams entries that must be PRESENT and DIFFERENT from the value given — the value
   * being the broken one the setup installed. "Raise the memory limit" has no single right
   * answer, and pinning one would score the model's taste rather than its diagnosis.
   */
  changed?: Record<string, string>;
}

export interface Score {
  pass: boolean;
  /** Why it missed. A number alone tells you the agent regressed, never what to look at. */
  reasons: string[];
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

export function scoreProposal(expect: Expectation, proposal: Proposal | null): Score {
  const reasons: string[] = [];

  if (expect.action === null) {
    return proposal
      ? { pass: false, reasons: [`proposed ${proposal.action} on ${proposal.namespace}/${proposal.name}, but the correct answer is no proposal`] }
      : { pass: true, reasons: [] };
  }
  if (!proposal) return { pass: false, reasons: [`no proposal; expected ${expect.action}`] };

  if (proposal.action !== expect.action) reasons.push(`action ${proposal.action}, expected ${expect.action}`);
  if (expect.namespace && proposal.namespace !== expect.namespace) {
    reasons.push(`namespace ${proposal.namespace}, expected ${expect.namespace}`);
  }
  if (expect.target && proposal.name !== expect.target) {
    reasons.push(`target ${proposal.name}, expected ${expect.target}`);
  }
  for (const [k, want] of Object.entries(expect.params ?? {})) {
    const got = str(proposal.toolParams[k]);
    if (got !== want) reasons.push(`${k}=${got ?? "(unset)"}, expected ${want}`);
  }
  for (const [k, broken] of Object.entries(expect.changed ?? {})) {
    const got = str(proposal.toolParams[k]);
    if (got === undefined) reasons.push(`${k} not set; it is what the fix has to change`);
    else if (got === broken) reasons.push(`${k}=${got}, unchanged from the broken value`);
  }
  return { pass: reasons.length === 0, reasons };
}

export interface TaskRun {
  task: string;
  /** One entry per attempt, in order. attempts[0] is what pass@1 reads. */
  attempts: Score[];
}

/**
 * pass@1 / pass@k / pass^k, borrowed from k8s-ai-bench and kept for the same reason: one run
 * of a nondeterministic agent is an anecdote.
 *
 * pass^k — every attempt passed — is the one that decides whether this can be trusted on call.
 * An agent that is right four times in five is not 80% useful; it is an agent whose output has
 * to be checked every time, which is most of the work it was meant to remove.
 */
export function passRates(runs: TaskRun[]): { pass1: number; passK: number; passHatK: number; k: number; tasks: number } {
  const tasks = runs.length;
  const k = Math.max(0, ...runs.map((r) => r.attempts.length));
  if (tasks === 0) return { pass1: 0, passK: 0, passHatK: 0, k, tasks };
  const frac = (n: number) => n / tasks;
  return {
    tasks,
    k,
    pass1: frac(runs.filter((r) => r.attempts[0]?.pass).length),
    passK: frac(runs.filter((r) => r.attempts.some((a) => a.pass)).length),
    // A task with no attempts has not been shown to be consistent, so `.length > 0` is load-bearing.
    passHatK: frac(runs.filter((r) => r.attempts.length > 0 && r.attempts.every((a) => a.pass)).length),
  };
}
