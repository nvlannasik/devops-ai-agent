// What a failed LLM call means to a PERSON (2026-11-24). Both heavy backends ran out of credit at once
// — deepseek `402 Insufficient Balance`, chatgpt `429 You have no credits remaining` — and every alert
// thread got "❌ Investigation failed:" followed by two Node.js stack traces. The router now keeps one
// line per backend with a kind, and `userFacingError` turns that into a sentence that says which
// backend, why, and what to do. The stack stays in the agent log, where it is useful.

export type FailureKind = "credit" | "auth" | "rate-limit" | "timeout" | "unavailable" | "malformed" | "other";

export interface BackendFailure {
  backend: string;
  kind: FailureKind;
  /** One line, no stack: what the backend said. */
  summary: string;
}

/** The first line of an error, without its stack — what may leave the log. */
export function oneLine(err: unknown, max = 180): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const first = raw.split("\n").find((l) => l.trim() && !/^\s*at\s/.test(l)) ?? raw;
  const s = first.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Literal wording first, codes second: a bare 429 is rate limiting, `429 no credits` is billing. */
export function classifyFailure(reason: string): FailureKind {
  if (/no credits remaining|insufficient[ _](balance|quota|credit|funds)|quota exceeded|billing|payment required|\b402\b|credit balance is too low/i.test(reason)) return "credit";
  if (/invalid[ _]api[ _]key|unauthori[sz]ed|incorrect api key|\b401\b|\b403\b|permission denied/i.test(reason)) return "auth";
  if (/\b429\b|rate[ _-]?limit|too many requests/i.test(reason)) return "rate-limit";
  if (/timed? ?out|timeout|deadline|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(reason)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed|\b50[0-4]\b|bad gateway|service unavailable|overloaded/i.test(reason)) return "unavailable";
  if (/tool calls? (written|as text)|empty (answer|response)|names a tool|malformed|not valid json/i.test(reason)) return "malformed";
  return "other";
}

/** Thrown by the router when no backend on the chain answered. `message` has no stack traces. */
export class AllBackendsFailedError extends Error {
  constructor(
    readonly route: "heavy" | "light",
    readonly failures: BackendFailure[],
    options?: { cause?: unknown }
  ) {
    super(`all LLM backends failed — ${failures.map((f) => `${f.backend}: ${f.summary}`).join("; ") || "none was usable"}`, options);
    this.name = "AllBackendsFailedError";
  }
}

const KIND_TEXT: Record<FailureKind, string> = {
  credit: "is out of credit",
  auth: "rejected its API key",
  "rate-limit": "is rate limiting us",
  timeout: "timed out",
  unavailable: "could not be reached",
  malformed: "answered with something unusable",
  other: "failed",
};

export type FailedWork = "alert" | "mention" | "postmortem" | "learn" | "remediation";

const WHAT: Record<FailedWork, string> = {
  alert: "I could not investigate this alert",
  mention: "I could not answer this",
  postmortem: "I could not draft the postmortem",
  learn: "I could not learn from this thread",
  remediation: "I could not handle this remediation",
};

/**
 * The Slack message for work that failed: which backends, why, and what a person can do — never a
 * stack trace. For an alert it also says the plain thing that matters most: nothing was checked, so
 * the alert still needs a person.
 */
export function userFacingError(err: unknown, work: FailedWork): string {
  const head = `⚠️ *${WHAT[work]}*`;
  const tail =
    work === "alert"
      ? "Nothing about the alert was checked, so it still needs a look by a person."
      : "";
  if (err instanceof AllBackendsFailedError || (err as { name?: string } | null)?.name === "AllBackendsFailedError") {
    const failures = (err as AllBackendsFailedError).failures ?? [];
    const kinds = new Set(failures.map((f) => f.kind));
    const lines = failures.map((f) => `• \`${f.backend}\` ${KIND_TEXT[f.kind]} — ${f.summary}`);
    let next: string;
    if (kinds.size === 1 && kinds.has("credit")) next = "Top up one of these backends, then mention me here (for example `@agent investigate`) to run it.";
    else if (kinds.size === 1 && kinds.has("rate-limit")) next = "That usually passes within minutes — mention me here to try again.";
    else if (kinds.has("credit") || kinds.has("auth")) next = "Fix the backend account or key, then mention me here to run it again.";
    else next = "Mention me here to try again; if it keeps failing, the agent log has the details.";
    const why = failures.length ? `every LLM backend I could use failed:\n${lines.join("\n")}` : "no LLM backend was usable.";
    return [`${head} — ${why}`, tail, next].filter(Boolean).join("\n");
  }
  return [`${head} — an internal error: \`${oneLine(err)}\`.`, tail, "Details are in the agent log."].filter(Boolean).join("\n");
}
