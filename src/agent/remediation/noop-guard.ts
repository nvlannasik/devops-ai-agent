/**
 * A change that cannot change anything.
 *
 * Sibling of `replace-guard.ts` and the same principle one step out: that one refuses a
 * REPLACEMENT that rebuilds the identical pod, this one refuses an EDIT that writes back the value
 * already there. Neither can reach a fault, and both arrive as a card a human is asked to approve.
 *
 * Measured on benchmark C03 against the `agus` backend, three attempts out of three: the container
 * is `busybox:1.36` running `sleep 3; exit 1`, it crashes with no logs, and the model proposed
 * `k8s_set_image` to **`busybox:1.36`** — the image it was already running. One of the three said
 * so in its own reason: *"Proposing reapplication of current image as it is the only known..."*.
 *
 * Deliberately NOT a confidence heuristic. The first design refused any proposal whose RCA rated
 * itself `Confidence: Low`, and measuring it over 496 recorded attempts found 14 such proposals of
 * which **4 were correct** — an OOMKill confirmed at a known limit is a fine reason to raise that
 * limit while staying unsure why memory grew. A no-op is decidable without guessing at the
 * model's certainty: the value it proposes is the value already in the spec.
 */

/** The `containers` entry of a `k8s_list_deployments` / `_statefulsets` / `_daemonsets` item. */
interface WorkloadItem {
  name?: unknown;
  containers?: Array<{ name?: unknown; image?: unknown }>;
}

/** Which listing tool holds the current spec for each kind the proposal may name. */
export const LISTING_FOR_KIND: Readonly<Record<string, string>> = {
  deployment: "k8s_list_deployments",
  statefulset: "k8s_list_statefulsets",
  daemonset: "k8s_list_daemonsets",
};

/**
 * Why this image change is a no-op, or null to let it through.
 *
 * Tolerant like `parsePods`: the payload is another repo's output, and anything unreadable returns
 * null and refuses nothing. It may only ever ADD a refusal.
 */
export function noOpImageRefusal(
  action: string,
  params: Record<string, unknown>,
  listing: string
): string | null {
  if (action !== "k8s_set_image") return null;
  const workload = typeof params.name === "string" ? params.name : "";
  const proposed = typeof params.image === "string" ? params.image : "";
  const container = typeof params.container === "string" ? params.container : "";
  if (!workload || !proposed) return null;

  const start = listing.indexOf("[");
  const end = listing.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let items: unknown;
  try {
    items = JSON.parse(listing.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;

  const mine = (items as WorkloadItem[]).find((w) => w && w.name === workload);
  const containers = mine?.containers;
  if (!Array.isArray(containers) || containers.length === 0) return null;

  // With a container named, only that one counts. Without, any container already on this image
  // makes the write a no-op for the thing being changed.
  const relevant = container ? containers.filter((c) => c.name === container) : containers;
  if (!relevant.some((c) => c.image === proposed)) return null;

  return (
    `the image being proposed is the image \`${workload}\` is already running (\`${proposed}\`), so this ` +
    `card would write the spec back to what it already says and change nothing. A rollout would restart ` +
    `the pods and they would come up on the same image, against the same fault. If the image really is ` +
    `the problem, the fix names a DIFFERENT tag — the one that was running before, or one the evidence ` +
    `shows works. If it is not the problem, say what is, or that the cause could not be determined.`
  );
}
