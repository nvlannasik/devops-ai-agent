/**
 * The last gate before a card that asks a human to replace a pod with an identical one.
 *
 * `k8s_rollout_restart` and `k8s_delete_pod` both do the same physical thing: destroy a pod and
 * let its controller rebuild it FROM THE SAME SPEC. So they repair exactly one class of fault —
 * a running process gone wrong — and none of the class that lives in the spec: a missing config
 * key, an image tag that does not exist, a limit set too low, a wrong probe path. Propose one
 * against a spec fault and the replacement reproduces it within seconds, after a human has
 * approved a change on our authority.
 *
 * The proposal prompt has said so twice, in progressively firmer words, and the benchmark says
 * it did not hold. Round one moved the failures off `k8s_rollout_restart`; `k8s_delete_pod`
 * inherited them, because its own rule read "while its siblings are healthy" and a single-replica
 * workload has no unhealthy sibling to contradict that. Round two closed that sentence and the
 * failures came back on both actions (A02, C03, C08). Two rounds is enough to conclude the
 * prompt is the wrong instrument, which is the same conclusion `worthProposing`, the namespace
 * scope lock and the log fan-out cap each reached before it.
 *
 * So the test moves to where a test can be made: the pods themselves, from `k8s_list_pods`.
 */

/** The fields of one `k8s_list_pods` entry this guard reads. The rest of the payload is ignored. */
export interface PodState {
  name: string;
  ready: boolean;
  restarts: number;
  /** The pod PHASE — `Pending` means no container has run yet, which is a fault a restart repeats. */
  status: string;
}

/**
 * Tolerant on purpose. The payload is another repo's tool output, and a guard that throws on an
 * unfamiliar shape would take down a proposal path that worked before it existed. Anything it
 * cannot read comes back empty, and an empty list refuses nothing — this can only ever ADD a
 * refusal, never remove a check that already runs.
 */
export function parsePods(raw: string): PodState[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let items: unknown;
  try {
    items = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const out: PodState[] = [];
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      ready: o.ready === true,
      restarts: typeof o.restarts === "number" ? o.restarts : 0,
      status: typeof o.status === "string" ? o.status : "",
    });
  }
  return out;
}

/**
 * The pods of one workload, by name prefix.
 *
 * A Deployment is only ever seen as `<workload>-<replicaset>-<pod>` and a StatefulSet as
 * `<workload>-<ordinal>`, so the prefix is the only join available here — the same reasoning
 * `agent/grounding/` already makes, and `k8s_list_pods` returns no owner references to do better.
 *
 * ponytail: `payments` also prefixes `payments-api-7d9f-x2k`. That over-match is deliberately the
 * safe direction: every rule below refuses only when EVERY matching pod looks broken, so pulling
 * in an unrelated healthy pod makes the guard stay quiet. It fails open, never shut.
 */
const podsOf = (pods: readonly PodState[], workload: string): PodState[] =>
  pods.filter((p) => p.name.startsWith(`${workload}-`));

/**
 * The siblings of one pod: the other pods created from the same template.
 *
 * Derived from the target's own name rather than the workload's, so a Deployment's siblings are
 * the ones in its OWN ReplicaSet — `api-6b747db7c9-zwdcv` and `api-6b747db7c9-m4p8t` are siblings,
 * and a pod from the previous ReplicaSet is not. That distinction is the case: mid-rollout, the
 * old ReplicaSet's pods are healthy and the new one's are not, and "one wedged pod among healthy
 * siblings" is exactly the wrong reading of it.
 */
function siblingsOf(pods: readonly PodState[], pod: string): PodState[] | null {
  // No dash means no generated suffix, so this is a bare pod nobody templated. Null rather than
  // an empty list: "it has no siblings" and "siblings cannot be identified" are different facts,
  // and only the first is grounds to refuse. A bare pod is not replaced when deleted at all —
  // whatever that is, it is not the case this guard reasons about.
  const cut = pod.lastIndexOf("-");
  if (cut <= 0) return null;
  const prefix = pod.slice(0, cut + 1);
  return pods.filter((p) => p.name !== pod && p.name.startsWith(prefix));
}

/**
 * Why this proposal must not become a card, or null to let it through.
 *
 * Two rules, each refusing only on evidence that the replacement has ALREADY been tried:
 *
 * - `k8s_delete_pod` claims one pod is wedged while its siblings are fine. If no sibling is
 *   ready — and a single-replica workload has no sibling at all — that claim has no support:
 *   whatever is wrong is wrong for every copy, which makes it the spec.
 * - `k8s_rollout_restart` claims a fresh pod would come up healthy. If every pod of the workload
 *   is unready AND has restarted at least once, the kubelet has already run that experiment,
 *   repeatedly, and the pods came back the same. Asking a human to approve one more is asking
 *   them to authorise something that has already failed.
 *
 * Ceiling, named: a pod that is Running, not ready and has NEVER restarted (a wrong readiness
 * probe path — benchmark A08) is not decidable from this payload, and it passes. Separating that
 * from a genuinely wedged process needs the probe result, which `k8s_list_pods` does not carry.
 */
export function replacementRefusal(
  action: string,
  params: Record<string, unknown>,
  pods: readonly PodState[]
): string | null {
  if (pods.length === 0) return null;

  if (action === "k8s_delete_pod") {
    const pod = typeof params.pod === "string" ? params.pod : "";
    if (!pod) return null;
    const siblings = siblingsOf(pods, pod);
    if (siblings === null || siblings.some((p) => p.ready)) return null;
    return (
      `deleting \`${pod}\` would replace it with an identical pod from the same spec, and there is no ` +
      `healthy sibling to show that a fresh one comes up any different` +
      (siblings.length === 0 ? " — this workload runs a single replica" : ` — all ${siblings.length + 1} pods are unready`) +
      `. Whatever is wrong is wrong for every copy, which puts it in the spec (config, image, limits, probe), ` +
      `and a delete does not change the spec.`
    );
  }

  if (action === "k8s_rollout_restart") {
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) return null;
    const mine = podsOf(pods, name);
    if (mine.length === 0) return null;
    if (mine.some((p) => p.ready)) return null;

    // Two ways the evidence can already show that a fresh identical pod does not come up healthy.
    const restarts = mine.reduce((n, p) => n + p.restarts, 0);
    if (mine.every((p) => p.restarts > 0)) {
      return (
        `a rolling restart rebuilds these pods from the same spec, and the kubelet has already done ` +
        `that ${restarts} time(s) — all ${mine.length} pod(s) of \`${name}\` are still unready. The fault ` +
        `survives a fresh identical pod, so it is in the spec (config, image, limits, probe) and a restart ` +
        `cannot reach it.`
      );
    }
    // Never even started. A pod that has not reached Running has failed BEFORE its process — it
    // cannot pull its image, cannot schedule, cannot mount its volume — and every one of those
    // lives in the spec. Added after benchmark A04: an ImagePullBackOff pod has restartCount 0
    // because the container never ran, so the restart-count rule alone let a restart card through
    // for a nonexistent pull secret.
    if (mine.every((p) => p.status !== "Running" && p.status !== "")) {
      const phases = [...new Set(mine.map((p) => p.status))].join("/");
      return (
        `a rolling restart replaces these pods with identical ones, and not one of the ${mine.length} ` +
        `pod(s) of \`${name}\` has reached Running — they are ${phases}. A pod that never started ` +
        `failed before its process did: it could not pull its image, schedule, or mount its volume, and ` +
        `all of those live in the spec. A fresh pod stops in exactly the same place.`
      );
    }
    return null;
  }

  return null;
}

/** The two actions this guard applies to — the ones that rebuild a pod from the same spec. */
export const REPLACEMENT_ACTIONS: ReadonlySet<string> = new Set(["k8s_rollout_restart", "k8s_delete_pod"]);
