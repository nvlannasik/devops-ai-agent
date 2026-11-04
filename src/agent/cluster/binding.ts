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

// Common Indonesian function words: enough to answer a fixed line in the language the user wrote in.
// ponytail: a word list, not a language detector — a message with none of these gets English.
const INDONESIAN =
  /\b(?:yang|apa|apakah|mana|di|ke|dari|ini|itu|ada|aja|saja|ga|gak|nggak|tidak|bisa|sudah|udah|belum|kenapa|gimana|bagaimana|tolong|cek|dong|nya|lagi|juga|dan|atau|untuk|buat|pindah|ganti)\b/i;
export const speaksIndonesian = (text: string): boolean => INDONESIAN.test(text);

/** The fixed lines a mention gets about its cluster — wholly in the user's language, never mixed. */
export const clusterReply = {
  which: (names: string[], id: boolean): string => {
    const list = names.map((n) => `\`${n}\``).join(", ");
    return id
      ? `☸ Saya memantau lebih dari satu cluster: ${list}. Pertanyaan ini untuk cluster yang mana? Balas dengan namanya (misalnya "di ${names[0]}"), nanti saya jawab di cluster itu.`
      : `☸ I watch more than one cluster: ${list}. Which one is this about? Reply with its name (e.g. "on ${names[0]}") and I'll answer your question there.`;
  },
  other: (bound: string, other: string, id: boolean): string =>
    id
      ? `☸ Thread ini tentang \`${bound}\`. Untuk melihat \`${other}\`, bilang "pindah ke ${other}" di sini (jawaban sebelumnya tetap tentang ${bound}), atau tanya di thread baru.`
      : `☸ This thread is about \`${bound}\`. To look at \`${other}\`, say "switch to ${other}" here (earlier answers stay about ${bound}), or ask in a new thread.`,
  switched: (from: string, to: string, id: boolean): string =>
    id
      ? `🔀 Thread ini sekarang memakai cluster ${to}. Jawaban sebelumnya tentang ${from}.`
      : `🔀 This thread now uses cluster ${to}. Earlier answers were about ${from}.`,
};

/** The note a VM incident's run opens with (spec 2026-11-04 Part B). */
export function vmNote(vm: { host: string; units: string[] }, label: string): string {
  return (
    `[Target: VM \`${vm.host}\`] Not a Kubernetes workload: there are no Kubernetes tools in this investigation. Its metrics, ` +
    `logs and traces are in the central stack under \`${label}="${vm.host}"\`. The only action available is restarting one of ` +
    `its units: ${vm.units.map((u) => `\`${u}\``).join(", ") || "none listed"}.`
  );
}

/**
 * The cluster an alert is about: its `cluster` label when the registry knows it, null when it has
 * none or names a cluster the registry does not know (an unlabelled alert — no Kubernetes, capped to
 * Low), undefined in single-cluster mode where there is nothing to bind.
 */
export function alertCluster(labels: Record<string, string>, registry: ClusterRegistry): string | null | undefined {
  if (!registry.strict) return undefined;
  const label = labels.cluster;
  return label && registry.names.includes(label) ? label : null;
}
