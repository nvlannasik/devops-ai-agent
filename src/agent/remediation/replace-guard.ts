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
/**
 * Is this pod actually serving, as opposed to serving at the instant we looked?
 *
 * `ready` is a snapshot, and a CrashLoopBackOff pod is ready for part of every cycle: benchmark
 * C03 and B04 run `sleep 3; exit 1`, so the container is alive and READY for three seconds of
 * each backoff window. Sampled there, `k8s_list_pods` returns `Running / ready: true / restarts: 2`
 * — measured, not theorised — and every rule below was skipped by the one-line early return that
 * asked only `some(p.ready)`. It is why the guard refused nothing at all across a 57-attempt run
 * while refusing correctly in the runs before it: the difference was WHEN the pods were sampled.
 *
 * So a pod that has restarted does not count as serving here. Trade named: a workload that
 * genuinely recovered after one restart is now treated as not-serving too, and a restart proposed
 * against it can be refused. That costs a card nobody needed — a restart of a recovered workload
 * repairs nothing — and it buys back a guard that does not depend on the sampling instant.
 */
const isServing = (p: PodState): boolean => p.ready && p.restarts === 0;

const podsOf = (pods: readonly PodState[], workload: string): PodState[] =>
  pods.filter((p) => p.name.startsWith(`${workload}-`));

/**
 * The ReplicaSet a Deployment pod belongs to, or null when the name is not that shape.
 *
 * `web-frontend-fc9b67d8f-9qhq4` → `web-frontend-fc9b67d8f`. Requires EXACTLY two segments after
 * the workload name, which is what makes this safe to group on where `podsOf` is not: `payments`
 * over-matches `payments-api-7d9f-x2k`, and that pod leaves three segments, so it is dropped
 * rather than counted as a second ReplicaSet of `payments`. A StatefulSet's `web-0` leaves one
 * segment and is dropped too — it has no ReplicaSets, so there is no rollout to detect.
 *
 * This one rule refuses on a MIXTURE of healthy and broken pods, unlike the two below it, so the
 * over-match that keeps those quiet would make this one fire wrongly. Hence the exact shape.
 */
function replicaSetOf(podName: string, workload: string): string | null {
  const parts = podName.slice(workload.length + 1).split("-");
  return parts.length === 2 ? `${workload}-${parts[0]}` : null;
}

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
 * Four rules. Two refuse only on evidence that the replacement has ALREADY been tried; the
 * other two refuse on a state where it provably cannot help:
 *
 * - `k8s_delete_pod` claims one pod is wedged while its siblings are fine. If no sibling is
 *   ready — and a single-replica workload has no sibling at all — that claim has no support:
 *   whatever is wrong is wrong for every copy, which makes it the spec.
 * - `k8s_rollout_restart` claims a fresh pod would come up healthy. If every pod of the workload
 *   is unready AND has restarted at least once, the kubelet has already run that experiment,
 *   repeatedly, and the pods came back the same. Asking a human to approve one more is asking
 *   them to authorise something that has already failed.
 * - `k8s_rollout_restart` against a workload whose pods span two ReplicaSets, one of them without
 *   a single ready pod. That is a stuck rollout: the failing ReplicaSet already runs the current
 *   spec, so a restart re-applies it, and the ready ReplicaSet is the one serving the traffic
 *   the restart would roll.
 * - `k8s_rollout_restart` against a workload whose pods are ALL Running, none ready, and none
 *   ever restarted. This was the ceiling this file named and declined to decide, on the grounds
 *   that separating a wrong readiness probe from a wedged process needs the probe result. It does
 *   not: in this exact shape a restart cannot help EITHER way. If readiness never passed, the
 *   probe or the config is wrong and a fresh pod runs the same one; if an external dependency is
 *   down, a fresh pod reports not-ready too. The remaining reading — a process that served and
 *   then wedged without ever restarting, on every replica at once — is the one case this refuses
 *   wrongly, and the refusal text says so, because the guard's output is read by a human who can
 *   still act on it.
 *
 * Failing open is the rule everywhere else in this file and this is the one rule that can refuse
 * a restart which might have worked. It earns that by how narrow it is: any ready pod anywhere in
 * the workload returns null two lines above, so this can only fire when NOT ONE replica is
 * serving and NOT ONE has ever been restarted by the kubelet.
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
    if (siblings === null || siblings.some(isServing)) return null;
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

    // A stalled rollout, and it has to be tested BEFORE the "no pod is ready" rules below —
    // in this shape the old ReplicaSet IS ready and would let every one of them through.
    // Benchmark A09, 0 for 6 across two runs: the new ReplicaSet's pods never become ready, the
    // old one keeps serving traffic, and the model proposes a restart "to verify if the issue is
    // transient". A restart re-applies the SAME spec the stalled ReplicaSet is already running,
    // so its pods stop in the same place — and it rolls the ReplicaSet that currently carries
    // the traffic. The fix is the spec: the image, the config, the limits, the probe.
    const groups = new Map<string, PodState[]>();
    for (const p of mine) {
      const rs = replicaSetOf(p.name, name);
      if (rs) groups.set(rs, [...(groups.get(rs) ?? []), p]);
    }
    if (groups.size >= 2) {
      const stalled = [...groups].filter(([, ps]) => !ps.some(isServing));
      const serving = [...groups].filter(([, ps]) => ps.some(isServing));
      if (stalled.length > 0 && serving.length > 0) {
        const [badName, bad] = stalled[0];
        return (
          `a rollout of \`${name}\` is in flight and stuck: all ${bad.length} pod(s) of ReplicaSet ` +
          `\`${badName}\` are unready while \`${serving[0][0]}\` still serves traffic. A rolling restart ` +
          `re-applies the same spec \`${badName}\` is already running, so its pods stop in exactly the ` +
          `same place — and it would roll the ReplicaSet currently carrying the traffic. What is wrong ` +
          `is in the spec the new ReplicaSet was built from (image, config, limits, probe); change that, ` +
          `or put back the image the serving ReplicaSet runs.`
        );
      }
    }

    if (mine.some(isServing)) return null;

    // Two ways the evidence can already show that a fresh identical pod does not come up healthy.
    const restarts = mine.reduce((n, p) => n + p.restarts, 0);
    if (mine.every((p) => p.restarts > 0)) {
      // Worded from the pods as read: a restarted pod can read ready (it recovered, or a crash
      // loop was sampled between crashes — see isServing), and this sentence goes into the
      // thread's memory, where "still unready" about a 1/1 Ready pod was repeated as fact.
      const ready = mine.filter((p) => p.ready).length;
      return (
        `a rolling restart rebuilds these pods from the same spec, and the kubelet has already done ` +
        `that ${restarts} time(s) — ` +
        (ready === 0
          ? `all ${mine.length} pod(s) of \`${name}\` are still unready. The fault survives a fresh identical ` +
            `pod, so it is in the spec (config, image, limits, probe) and a restart cannot reach it.`
          : `${ready} of ${mine.length} pod(s) of \`${name}\` read as ready now, which a recovered pod and a ` +
            `crash loop between crashes both show. Either way a restart repeats what already ran: it repairs ` +
            `nothing on a recovered pod, and a crash loop's fault is in the spec (config, image, limits, probe).`)
      );
    }
    // Never even started. A pod that has not reached Running has failed BEFORE its process — it
    // cannot pull its image, cannot schedule, cannot mount its volume — and every one of those
    // lives in the spec. Added after benchmark A04: an ImagePullBackOff pod has restartCount 0
    // because the container never ran, so the restart-count rule alone let a restart card through
    // for a nonexistent pull secret.
    // Running, never ready, never restarted. Benchmark A08 (a readinessProbe pointing at
    // /healthz on an nginx image that serves no such path) and C08 both reached a restart card
    // through the gap this closes.
    if (mine.every((p) => p.status === "Running" && p.restarts === 0)) {
      return (
        `all ${mine.length} pod(s) of \`${name}\` are Running with zero restarts and not one is ready. ` +
        `The containers started and have never been killed, so what is failing is the readiness check ` +
        `itself — a probe path, a port, or a dependency the app waits on. A rolling restart builds ` +
        `identical pods that run the same probe against the same image and config, and they stop in ` +
        `exactly the same place. If instead this workload WAS serving and stopped, that is a wedge and ` +
        `a restart is the right call — but nothing in the pod list shows it, so say so explicitly.`
      );
    }
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

/** `name` appears in `text` as a whole Kubernetes name — `api` is not mentioned by `payments-api`. */
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Kinds that are never the workload a restart rebuilds, however they are spelled before the name.
const NOT_A_WORKLOAD = "services?|svc|ingress(?:es)?|configmaps?|cm|secrets?|endpoints?|endpointslices?|serviceaccounts?|networkpolic(?:y|ies)|netpol|pvcs?|persistentvolumeclaims?|hpas?|horizontalpodautoscalers?";
// A citation is `_tool_name_ \`argument\`` (rca-format): where the evidence came from, not a claim
// about what is broken — "_k8s_get_endpoints_ `bench-a10/api`" cites the Service.
const CITATION = /_[a-z0-9_]+_\s*`[^`\n]*`/gi;

/**
 * Does `text` name `name` AS the fault? A Service, Ingress or ConfigMap of the same name does not
 * count, and neither does a tool citation (bench A10, 2026-10-08: "Service `bench-a10/api` has no
 * ready endpoints" let a restart of the healthy Deployment `api` through, twice).
 */
const names = (text: string, name: string): boolean => {
  if (!name) return false;
  const n = reEsc(name);
  const own = text
    .replace(CITATION, " ")
    .replace(new RegExp(`\\b(?:${NOT_A_WORKLOAD})(?:\\s*[\`'"]?(?:[a-z0-9-]+/)?|[/=])${n}(?![a-z0-9-])`, "gi"), " ");
  return new RegExp(`(?<![a-z0-9-])${n}(?![a-z0-9-])`, "i").test(own);
};

/**
 * The other half of the question: a restart against a workload that is FINE.
 *
 * `replacementRefusal` refuses a replacement that cannot help a broken pod; it lets every serving
 * pod through by design, because a process can wedge while still reading ready. Incident 207
 * (2026-10-03) went through that door: a healthy certificate, and a card to restart
 * `devops-ai-agent` — the agent itself — whose pods were all ready with zero restarts. Nothing
 * named it as the fault; it was the workload that happened to live in that namespace.
 *
 * So when every target pod is serving, the restart needs SOMETHING to say this workload is the
 * fault: the RCA's Root Cause names it, or the alert does (`mentions` is both). The legitimate
 * healthy-pod restarts — a stale certificate mount, a wedged connection pool — are exactly the
 * ones whose root cause names the workload, so they pass. A human asking in words skips this, like
 * every replacement guard (`userRequested`).
 *
 * Fails open like the rest of this file: no matching pods, or any pod not serving, returns null.
 */
export function healthyTargetRefusal(
  action: string,
  params: Record<string, unknown>,
  pods: readonly PodState[],
  mentions: string
): string | null {
  if (action === "k8s_rollout_restart") {
    const name = typeof params.name === "string" ? params.name : "";
    const mine = podsOf(pods, name);
    if (!name || mine.length === 0 || !mine.every(isServing) || names(mentions, name)) return null;
    return (
      `all ${mine.length} pod(s) of \`${name}\` are ready with zero restarts, and neither the root cause nor ` +
      `the alert names \`${name}\` as the fault. A rolling restart of a healthy workload repairs nothing — ` +
      `it only rolls pods that are serving. If \`${name}\` really is wedged while reading ready, the root ` +
      `cause has to say so and why; otherwise the action belongs on the workload the root cause names.`
    );
  }
  if (action === "k8s_delete_pod") {
    const pod = typeof params.pod === "string" ? params.pod : "";
    const target = pods.find((p) => p.name === pod);
    if (!target || !isServing(target)) return null;
    // the pod, its ReplicaSet, or its workload — `web-6b747db7c9-a1b2c` → `web-6b747db7c9` → `web`
    const parts = pod.split("-");
    const candidates = [pod, parts.slice(0, -1).join("-"), parts.slice(0, -2).join("-")];
    if (candidates.some((c) => names(mentions, c))) return null;
    return (
      `\`${pod}\` is ready with zero restarts, and neither the root cause nor the alert names it or its ` +
      `workload as the fault. Deleting a healthy pod repairs nothing; if it is wedged while reading ready, ` +
      `the root cause has to say so.`
    );
  }
  return null;
}

/** The two actions this guard applies to — the ones that rebuild a pod from the same spec. */
export const REPLACEMENT_ACTIONS: ReadonlySet<string> = new Set(["k8s_rollout_restart", "k8s_delete_pod"]);

/**
 * A restart proposed against an RBAC denial.
 *
 * Bench A13, 2026-10-07: the reporter's ServiceAccount cannot list pods, and the card was a
 * restart "to refresh pod permissions". RBAC is evaluated by the API server on every request, so
 * a replacement pod — same ServiceAccount, same token — is denied the same way, and a fixed Role
 * applies to the running pod without one. The fix is the Role/RoleBinding, which goes through Git.
 *
 * Narrow on purpose: only a denial naming a ServiceAccount IN THE TARGET'S NAMESPACE counts, so the
 * agent's own tools being forbidden somewhere (`system:serviceaccount:devops-tools:…`) refuse
 * nothing elsewhere. Quotes may arrive escaped — the log line is inside a JSON tool result.
 */
export function rbacRestartRefusal(action: string, params: Record<string, unknown>, observed: string | null): string | null {
  if (!REPLACEMENT_ACTIONS.has(action) || !observed) return null;
  const ns = typeof params.namespace === "string" ? params.namespace : "";
  if (!ns) return null;
  const esc = ns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Quotes and backslashes out first: the line arrives escaped as many times as it was wrapped
  // (Loki's result carries three levels), so no width between the tokens is ever the right one.
  const plain = observed.replace(/[\\"']/g, "");
  const denial = new RegExp(
    `system:serviceaccount:${esc}:([a-z0-9.-]+)\\s+cannot (get|list|watch|create|update|patch|delete) resource\\s+([a-z0-9.-]+)`,
    "i"
  ).exec(plain);
  if (!denial) return null;
  return (
    `the evidence is an RBAC denial — ServiceAccount \`${ns}/${denial[1]}\` cannot ${denial[2]} ` +
    `\`${denial[3]}\`. The API server checks RBAC on every request, so a restarted pod presents the same ` +
    `ServiceAccount and is denied the same way; a corrected Role applies to the running pod without one. ` +
    `The fix is the Role or RoleBinding granting that verb, and it belongs in Git.`
  );
}
