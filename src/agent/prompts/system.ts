import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { config } from "../../config/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve path: works for both dev (src/) and prod (dist/)
// prompts/system.md lives at project root, so walk up from src/agent/prompts/
function resolvePromptPath(): string {
  // dev: __dirname = <root>/src/agent/prompts → walk up 3 levels
  // prod: __dirname = <root>/dist/src/agent/prompts → walk up 4 levels
  const candidates = [
    join(__dirname, "../../../prompts/system.md"),   // dev
    join(__dirname, "../../../../prompts/system.md"), // prod
  ];
  for (const p of candidates) {
    try {
      readFileSync(p); // test readability
      return p;
    } catch {
      continue;
    }
  }
  throw new Error("Could not find prompts/system.md");
}

/**
 * Appended to the core prompt only when SUBAGENT_ENABLED is set.
 *
 * The first deployed build carried the delegate tool and its full description, on the alert path,
 * with an unlimited budget — and the model never once called it. That is the finding MEMORY_BANK
 * records for every other behaviour in this loop: one tool description among fifty is not where a
 * model forms strategy. The system prompt is.
 *
 * Safe to cache despite being conditional: SUBAGENT_ENABLED is env, fixed for the process, so the
 * string this returns is still ONE constant per process — one ephemeral block, no per-request
 * rewrite (llm/claude.ts). With the flag off the returned prompt is the file, byte for byte,
 * which is what keeps OFF usable as the baseline ON is measured against.
 *
 * It keys on the TOOL LIST, not on the flag, because the two disagree by design: delegation is
 * offered only to a run with an unlimited tool budget (subagent/offersDelegation), so on a plain
 * mention this section is in the prompt while the tool is not in the array. Telling the model to
 * check what it actually has is one sentence; a second cached prompt to keep them in step is a
 * second thing to keep in step.
 */
export const DELEGATION_SECTION = `

## Parallel Investigation

\`delegate_investigation\` hands ONE hypothesis to a delegate that investigates it in its own
context and reports back. It is not offered on every turn — when it is not in your tool list,
investigate everything yourself and do not mention it.

Use it when the incident has two or more genuinely different candidate causes that each need
their own multi-step investigation: a deploy regression, resource exhaustion, a failing
dependency. Issue them in the SAME turn so they run in parallel; a later turn cannot delegate
again. Investigating competing causes in one context is what makes the evidence for one bleed
into the reasoning about another — that is the problem this solves.

Do NOT delegate to fetch one piece of data. Call the data tool directly; a delegate costs a
whole investigation to answer what one call answers.

A delegate reports prose, and its claims name the tool that produced them. A claim that names no
tool is unverified: say so in your RCA rather than repeating it as fact.`;

/** Exported for the test — buildStaticSystemPrompt is a thin caller around the file read. */
export const composeSystemPrompt = (core: string, subagentsEnabled: boolean): string =>
  subagentsEnabled ? core + DELEGATION_SECTION : core;

let _cachedPrompt: string | null = null;

export function buildStaticSystemPrompt(): string {
  if (!_cachedPrompt) {
    _cachedPrompt = composeSystemPrompt(
      readFileSync(resolvePromptPath(), "utf-8").trim(),
      config.subagents.enabled
    );
  }
  return _cachedPrompt;
}

export function buildTimeContext(): string {
  const now = new Date();
  const unix_now = Math.floor(now.getTime() / 1000);
  const unix_30m_ago = unix_now - 1800;
  const unix_1h_ago = unix_now - 3600;
  const unix_6h_ago = unix_now - 21600;

  return `[TIME CONTEXT — use these unix timestamps as tool parameters]
unix_now:     ${unix_now}  (${now.toISOString()})
unix_30m_ago: ${unix_30m_ago}
unix_1h_ago:  ${unix_1h_ago}
unix_6h_ago:  ${unix_6h_ago}

Prometheus default 1h range: start=${unix_1h_ago} end=${unix_now} step=60
Prometheus spike  30m range:  start=${unix_30m_ago} end=${unix_now} step=15
Loki default range:           start=${unix_30m_ago} end=${unix_now}`;
}

export interface ThreadAlert {
  alertname: string;
  namespace: string | null;
}

/**
 * The mention path's per-message marker — same mechanism as `[FOLLOW-UP ...]` and for the same
 * reason: a distant system-prompt rule does not hold on a small model, so every entry point
 * stamps its own (see MEMORY_BANK §Response Mode).
 *
 * The alert clause is the newer half. The alert text does sit at history[0] and IS pinned by
 * fitToBudget, but by the second or third round it is one sentence at the far end of the window
 * against a freshly compacted tool result — and that is how a question about `sample-apps` came
 * to query `default`: a Loki dump named a hostname in another namespace and nothing nearby said
 * what the thread was about. Restating it on every message puts the anchor next to the question.
 *
 * It anchors rather than forbids, deliberately. The cross-namespace hop that prompted this may
 * well have been correct — the logs named a Service the workload really calls — so the rule asks
 * for the evidence that justifies leaving, not for staying put. The deterministic namespace lock
 * in the loop is the one that blocks; this one only has to keep the subject in view.
 */
export function buildMentionMarker(text: string, alert: ThreadAlert | null): string {
  const anchor = alert
    ? ` This thread is about the ${alert.alertname} incident` +
      (alert.namespace ? ` in namespace \`${alert.namespace}\`` : "") +
      `; keep that the subject. Looking outside it is allowed only when a tool result you have ` +
      `already read points there, and then say which one did.`
    : "";

  return (
    `[USER MESSAGE — conversation mode by default: answer directly in Slack mrkdwn. ` +
    `Do NOT use the RCA incident format unless this message explicitly asks to investigate an incident. ` +
    `If this is not about this cluster's workloads, observability data, incidents or deploys, decline in one line ` +
    `per Scope of Work and answer nothing else — do not debug or explain code.${anchor}]\n${text}`
  );
}
