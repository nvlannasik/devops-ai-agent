// Advice an RCA must never give, whatever the model concluded (2026-11-20).
//
// The gate chain (refusalFor) keeps these actions off an approval card, but an RCA is read by a
// person who can do them by hand. On 2026-11-17 the RCA for master3-vm's MemoryPressure told on-call
// to "Cordón master3-vm" (TL;DR, actions table, runbook) and to "review memory requests/limits for
// kube-apiserver" and "move control-plane pods to other nodes" — while the node gate refused the
// card. A small model holds these rules in the prompt only some of the time; this checks the text.
//
// One list, read by the answer gate (loop/answer-gates.ts adviceGate: one rewrite round, then a
// footer) and naming the same reasons the gates give. Each rule matches ONE line at a time and skips
// a match a negation governs ("do not cordon", "jangan restart etcd"), because the right RCA says
// exactly those words.

export interface UnsafeAdvice {
  rule: "cordon-control-plane" | "limit-control-plane" | "restart-etcd" | "move-static-pods" | "delete-control-plane-pod";
  /** The line the advice was found on, trimmed. */
  line: string;
  /** Why it must not be done — goes to the model in the notice and to the reader in the footer. */
  why: string;
}

const CONTROL_PLANE_COMPONENTS = "kube-apiserver|kube-controller-manager|kube-scheduler|etcd";
// A negation shortly before the verb — the line tells the reader NOT to do it.
const NEGATED = /\b(?:not|never|don'?t|do not|avoid|without|jangan|tidak|bukan)\b[^.;:\n]{0,40}$/i;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The control-plane nodes the evidence names: the node of each static pod (`kube-apiserver-<node>`
 * and its siblings) and every node a listing reports with the control-plane role.
 */
export function controlPlaneNodes(evidence: string): string[] {
  const out = new Set<string>();
  for (const m of evidence.matchAll(/\bkube-(?:apiserver|controller-manager|scheduler)-([a-z0-9][a-z0-9.-]*[a-z0-9])\b/g)) out.add(m[1]!);
  for (const m of evidence.matchAll(/"name"\s*:\s*"([a-z0-9][a-z0-9.-]*)"[^{}]{0,400}?"roles"\s*:\s*\[[^\]]*"(?:control-plane|master)"/g)) out.add(m[1]!);
  return [...out];
}

function hits(line: string, re: RegExp): boolean {
  for (const m of line.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
    if (!NEGATED.test(line.slice(0, m.index))) return true;
  }
  return false;
}

/** Every line of `answer` that advises one of the never-actions, given what the evidence shows. */
export function unsafeAdvice(answer: string, evidence: string): UnsafeAdvice[] {
  const planes = controlPlaneNodes(evidence);
  const found: UnsafeAdvice[] = [];
  const add = (rule: UnsafeAdvice["rule"], line: string, why: string) => {
    if (!found.some((f) => f.rule === rule)) found.push({ rule, line: line.trim().slice(0, 200), why });
  };
  const nodeRe = planes.length
    ? new RegExp(`\\b(?:cord[oó]n\\w*|drain\\w*)\\b[^\\n]{0,60}?\\b(?:${planes.map(escapeRe).join("|")})\\b`, "i")
    : null;
  for (const raw of answer.split("\n")) {
    const line = raw.replace(/[*_`]/g, "");
    if (nodeRe && hits(line, nodeRe)) {
      add(
        "cordon-control-plane",
        raw,
        "a control-plane node is never cordoned or drained: its pods are the API server, scheduler and controller manager, and a cordon frees no memory — the fix is the machine's capacity"
      );
    }
    if (
      hits(line, new RegExp(`\\b(?:set|raise|increase|lower|reduce|add|review|adjust|tune|cap|limit)\\w*\\b[^\\n]{0,40}\\b(?:limits?|requests?|resources)\\b[^\\n]{0,40}\\b(?:${CONTROL_PLANE_COMPONENTS})\\b`, "i")) ||
      hits(line, new RegExp(`\\b(?:${CONTROL_PLANE_COMPONENTS})\\b[^\\n]{0,40}\\b(?:memory |cpu )?(?:limits?|requests?)\\b[^\\n]{0,20}\\b(?:to|=|of)\\b`, "i"))
    ) {
      add(
        "limit-control-plane",
        raw,
        "the API server, etcd, controller manager and scheduler are never resized: a memory limit makes the API server or etcd the OOM victim and takes the control plane down"
      );
    }
    if (hits(line, /\b(?:restart\w*|systemctl\s+restart)\b[^\n]{0,30}\betcd\b/i)) {
      add("restart-etcd", raw, "etcd is never restarted as a fix: a restart of one member risks quorum and loses nothing that was using memory");
    }
    if (hits(line, /\b(?:move|reschedul\w*|migrat\w*|relocat\w*|spread)\b[^\n]{0,40}\bcontrol[- ]plane\s+(?:pods?|components?|workloads?)\b/i)) {
      add(
        "move-static-pods",
        raw,
        "control-plane pods are static pods, bound to their node by the kubelet's manifests — they cannot be moved; move WORKLOAD pods off the node, or add capacity"
      );
    }
    if (hits(line, new RegExp(`\\b(?:delete|kill|evict)\\w*\\b[^\\n]{0,30}\\b(?:${CONTROL_PLANE_COMPONENTS})-[a-z0-9]`, "i"))) {
      add("delete-control-plane-pod", raw, "a static control-plane pod is never deleted: the kubelet recreates it at once and the API is unavailable meanwhile");
    }
  }
  return found;
}

/** The notice the model gets for its one rewrite round. */
export const UNSAFE_ADVICE_NOTICE = (found: UnsafeAdvice[]): string =>
  `[UNSAFE ADVICE — your answer tells the reader to do something that must never be done here:\n` +
  found.map((f) => `- "${f.line}" — ${f.why}.`).join("\n") +
  `\nTake each of these out of every section (TL;DR, Recommended Actions, Runbook) and say what DOES help ` +
  `instead. Do not keep it as an option or a "consider". Then post the COMPLETE RCA again, every section in ` +
  `order — this reply replaces the previous one.]`;

/** What the reader sees when the rewrite round could not take it out: the reason, under the RCA. */
export const unsafeAdviceFooter = (found: UnsafeAdvice[]): string =>
  `\n\n:no_entry: *Not to be done, whatever the analysis above says* — the agent refuses these whoever asks:\n` +
  found.map((f) => `• ${f.why}`).join("\n");
