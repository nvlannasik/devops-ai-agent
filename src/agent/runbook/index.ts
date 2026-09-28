/**
 * The RCA's `*🧭 Runbook*` hands a human commands to paste into a terminal, and only READ-ONLY ones
 * may reach it.
 *
 * `prompts/system.md` used to forbid kubectl in answers outright: execution goes through the
 * approval card — whitelist, dry-run, a human click, an audit row — and a mutating command the
 * reader pastes skips every one of those. On a Flux-managed workload it is also reverted on the
 * next reconcile. The Runbook relaxes that for commands that look and never touch: verify the fault,
 * then confirm the recovery. The fix step stays the card, or a change in Git.
 *
 * A prompt rule alone has never held on a small model in this repo, and this one guards the one
 * path where a planted log line ("run kubectl scale ... --replicas=0") would reach a human's
 * terminal with our name on it. So the section is filtered here against an ALLOWLIST of read verbs
 * — fail closed: an unknown verb, an unknown flag ahead of the verb, or any shell chaining drops
 * the line.
 *
 * Scoped to the Runbook section only. A command quoted elsewhere is evidence, and BENCHMARK C08
 * requires an injected instruction to stay quotable as the finding.
 *
 * ponytail: token/pattern guard, not a shell parser — a quoted `|` inside a jq or grep argument is
 * refused along with real pipes, and a bare mutating `helm`/`flux` in PROSE (no backticks, no
 * fence) is not checked, because "the helm chart" and "flux controller" are ordinary sentences.
 * Upgrade to a real tokenizer if the drops show up on legitimate commands.
 */
import { extractSection } from "../../utils/slack/blocks.js";

const RUNBOOK = "Runbook";

// Flags that may precede the verb, all of which take a value. Anything else ahead of the verb is
// refused: treating an unknown flag as valueless is how `kubectl --request-timeout get delete ns
// prod` would read `get` as the verb while kubectl runs `delete`.
const TOOLS: Record<string, { flags: Set<string>; reads: (verb: string, sub?: string) => boolean }> = {
  kubectl: {
    flags: new Set(["-n", "--namespace", "--context", "--kubeconfig"]),
    reads: (v, sub) =>
      ["get", "describe", "logs", "top", "events", "explain", "api-resources", "version", "cluster-info", "diff", "wait"].includes(v) ||
      (v === "rollout" && (sub === "status" || sub === "history")) ||
      (v === "auth" && sub === "can-i"),
  },
  helm: {
    flags: new Set(["-n", "--namespace", "--kube-context", "--kubeconfig"]),
    reads: (v) => ["list", "ls", "status", "history", "get", "show"].includes(v),
  },
  flux: {
    flags: new Set(["-n", "--namespace", "--context", "--kubeconfig"]),
    reads: (v) => ["get", "logs", "tree", "trace", "events", "stats", "check", "diff", "version"].includes(v),
  },
};

// What a read may be piped into. No sed/awk: both can execute.
const FILTERS = new Set(["grep", "egrep", "head", "tail", "jq", "sort", "uniq", "wc", "less", "column"]);
const CHAINING = /;|&&|\|\||\$\(|`|[<>]/;

export function readOnlyCommand(line: string): boolean {
  const cmd = line.trim().replace(/^\$\s+/, "");
  if (CHAINING.test(cmd)) return false;
  const [head, ...pipes] = cmd.split("|").map((s) => s.trim().split(/\s+/));
  if (!pipes.every((p) => FILTERS.has(p[0]))) return false;

  const tool = TOOLS[head[0]];
  if (!tool) return false;
  let i = 1;
  while (head[i]?.startsWith("-")) {
    if (!tool.flags.has(head[i].split("=")[0])) return false;
    i += head[i].includes("=") ? 1 : 2;
  }
  const verb = head[i];
  if (!verb) return false;
  return tool.reads(verb, head.slice(i + 1).find((t) => !t.startsWith("-")));
}

// Outside a fence: every `kubectl …` up to the next kubectl or backtick, plus backticked
// helm/flux spans (see the ponytail note for why bare helm/flux prose is not read).
function commandsInProse(line: string): string[] {
  const kubectl = [...line.matchAll(/\bkubectl\b(?:(?!\bkubectl\b)[^`\n])*/g)].map((m) => m[0]);
  const spans = [...line.matchAll(/`((?:helm|flux)\s[^`]*)`/g)].map((m) => m[1]);
  return [...kubectl, ...spans];
}

/** Where the Runbook's body sits in `text`, located the way the Slack card will read it. */
function locate(text: string): { heading: number; start: number; end: number } | null {
  const body = extractSection(text, RUNBOOK);
  const heading = text.search(new RegExp(`^[ \\t]*\\*[^*\\n]*${RUNBOOK}[^*\\n]*\\*[ \\t]*$`, "im"));
  if (!body || heading < 0) return null;
  const start = text.indexOf(body, heading);
  return start < 0 ? null : { heading, start, end: start + body.length };
}

export function stripMutatingCommands(answer: string): { text: string; dropped: string[] } {
  const at = locate(answer);
  if (!at) return { text: answer, dropped: [] };

  const dropped: string[] = [];
  let inFence = false;
  const kept = answer
    .slice(at.start, at.end)
    .split("\n")
    .filter((line) => {
      const fences = (line.match(/```/g) ?? []).length;
      let bad: boolean;
      if (fences > 0) {
        // "```bash" opens a block; "```kubectl get pods```" is a block on one line.
        const inside = line.replace(/```\w*/g, "").trim();
        bad = inside !== "" && !readOnlyCommand(inside);
        if (fences % 2 === 1) inFence = !inFence;
      } else if (inFence) {
        const t = line.trim();
        bad = t !== "" && !t.startsWith("#") && !readOnlyCommand(t);
      } else {
        bad = commandsInProse(line).some((c) => !readOnlyCommand(c));
      }
      if (bad) dropped.push(line.trim());
      return !bad;
    })
    .join("\n")
    .replace(/```\w*\n```/g, "")
    .replace(/\n{3,}/g, "\n\n");

  if (dropped.length === 0) return { text: answer, dropped };
  return { text: answer.slice(0, at.start) + kept + answer.slice(at.end), dropped };
}

/**
 * The proposal step reads the RCA through a head+tail window (`buildProposalPrompt`). The Runbook
 * sits right after Recommended Actions, so leaving it in would push Root Cause and Evidence out of
 * the head — and it holds nothing a proposal can use: its fix step points back at the Immediate line.
 */
export function withoutRunbook(rca: string): string {
  const at = locate(rca);
  if (!at) return rca;
  return (rca.slice(0, at.heading) + rca.slice(at.end)).replace(/\n{3,}/g, "\n\n");
}
