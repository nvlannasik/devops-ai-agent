import type { ClusterRegistry } from "./index.js";

// Which cluster a Slack message is about (spec 2026-11-02 §2). A registry name counts only as a
// whole word: `devops-ai-agent` and `dev.annasik.cloud` must not bind `dev`, so a name next to a
// letter, digit, dot or dash is part of something else — the same boundary agent/grounding uses.
const word = (name: string) => new RegExp(`(?<![a-z0-9.-])${name}(?![a-z0-9.-])`, "i");
const SWITCH = (name: string) =>
  new RegExp(`\\b(?:pindah|ganti|beralih|switch|move)\\b[^.\\n]{0,20}?\\b(?:ke|to)\\s+(?:cluster\\s+)?${name}(?![a-z0-9.-])`, "i");

/**
 * The cluster a message names, or null. Two different clusters named ("bandingkan dev dan stg")
 * bind neither: guessing one would answer about the cluster the reader did not mean.
 */
export function parseClusterMention(text: string, names: string[]): { cluster: string; switch: boolean } | null {
  const named = names.filter((n) => word(n).test(text));
  if (named.length !== 1) return null;
  const cluster = named[0]!;
  return { cluster, switch: SWITCH(cluster).test(text) };
}

/**
 * The one line that opens the user message in strict mode — never the system prompt, which stays
 * byte-identical for the prompt cache. The PromQL/LogQL rule is a prompt rule only; enforcing it in
 * code is 2b. Both clusters have a node named worker1, so an unfiltered query mixes them.
 */
export function clusterNote(state: { cluster: string | null; reason: "bound" | "unbound" | "unlabelled" }, registry: ClusterRegistry): string {
  const list = registry.names.join(", ");
  if (state.cluster) {
    return (
      `[Cluster: ${state.cluster}] Kubernetes tools read cluster ${state.cluster}. Every PromQL and LogQL selector must ` +
      `include cluster="${state.cluster}" — the central Prometheus and Loki hold every cluster (${list}), and node names repeat across them.`
    );
  }
  if (state.reason === "unlabelled") {
    return (
      `[Cluster: unknown] This alert has no \`cluster\` label that names a known cluster (${list}), so there are no Kubernetes ` +
      `tools in this investigation. Investigate from metrics and logs, and say in the RCA that the alert is missing its cluster label.`
    );
  }
  return (
    `[Cluster: none] No cluster is bound to this thread, so there are no Kubernetes tools. Answer what metrics and logs ` +
    `can show, then ask which cluster this is about: ${list}.`
  );
}
