/**
 * Credential-ish identifiers never leave the agent in clear (decision 2026-10-08, every backend:
 * the external APIs and the private LLM alike). IPs, emails, AWS ARNs and account ids, and
 * hostnames are replaced with stable tokens before a request is sent, and every token is restored
 * in the response — text and tool_use inputs — before the loop sees it. So tools receive real
 * values, and memory, the trace, grounding, the dashboard and Slack never see a token at all.
 *
 * Deliberately NOT masked: workload, pod, Service and namespace names. The model reasons with them
 * ("checkout-gateway times out calling orders-api") and the cluster tour guesses a workload's
 * purpose from its name. Also left alone, by allowlist: Kubernetes label domains, public image
 * registries, in-cluster DNS, and file names — they are not secrets and the model needs them.
 *
 * Tokens are a hash of the value, so the same IP is the same token in every call of an
 * investigation with no state kept between calls. The system prompt is not touched: it is static,
 * holds no cluster identifiers, and Anthropic caches it as one block that must stay byte-identical.
 *
 * ponytail: pattern-based, like agent/injection — an identifier in an unusual shape gets through.
 * It is a reduction of what leaves, not a guarantee; the guarantee is not sending the cluster at all.
 */
import { createHash } from "node:crypto";
import type { ContentBlock, LLMClient, LLMResponse, Message } from "./types.js";

type Kind = "ip" | "email" | "arn" | "acct" | "host";
const TOKEN = /\b(?:ip|email|arn|acct|host)-[0-9a-f]{6}\b/g;

const token = (kind: Kind, value: string, rev: Map<string, string>): string => {
  const t = `${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 6)}`;
  rev.set(t, value);
  return t;
};

const ARN = /\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:[^\s"'`,)\]}]+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
// Only in a context that says it is one: a bare 12-digit number is as likely a byte count.
const ACCOUNT = /\b(account[\s_-]*(?:id)?["'\s:=]{0,4})(\d{12})\b/gi;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const HOST = /(?<![\w.@-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?![\w-])/gi;

// A real TLD, so `status.renewalTime` and `metadata.name` — field paths the skills and tool output
// are full of — are never mistaken for hosts. Generic TLDs here; any two letters is a ccTLD.
const GENERIC_TLD = new Set(
  "com net org io dev app cloud co ai me info biz xyz tech site online store page link live team tools run systems services email digital network host space pro tv".split(" ")
);
// Two-letter ccTLDs that are far more often a file extension in this domain.
const FILE_EXT = new Set("md sh py rs pl cc so tf ps mk ts js go rb".split(" "));
// Not secrets, and the model reasons with them: label/annotation domains and public registries.
const ALLOW_SUFFIX = [
  "kubernetes.io", "k8s.io", "fluxcd.io", "helm.sh", "cert-manager.io", "prometheus.io", "grafana.com",
  "ghcr.io", "docker.io", "quay.io", "gcr.io", "fluentbit.io", "github.com", "githubusercontent.com", "golang.org", "opentelemetry.io",
  // This cluster's own label/annotation domains (k3s, flannel, Rancher's wrangler, Longhorn) — found
  // tokenised in a live pod and node listing, 2026-10-08.
  "k3s.io", "coreos.com", "cattle.io", "longhorn.io",
];
// Loopback and the unspecified address identify nothing, and they ARE the diagnosis in "refused
// 127.0.0.1:5432" (an app pointed at localhost) or "listening on 0.0.0.0".
const NOT_AN_ADDRESS = /^(?:127\.|0\.0\.0\.0$)/;
const INTERNAL = /\.(?:local|svc|internal|cluster|localhost|lan)$/i;

function isMaskableHost(host: string, tld: string): boolean {
  const t = tld.toLowerCase();
  if (!(GENERIC_TLD.has(t) || (t.length === 2 && !FILE_EXT.has(t)))) return false;
  const h = host.toLowerCase();
  if (INTERNAL.test(h)) return false;
  return !ALLOW_SUFFIX.some((s) => h === s || h.endsWith(`.${s}`));
}

/** One string, masked; `rev` collects token → original for the response. Exported for tests. */
export function maskText(text: string, rev: Map<string, string>): string {
  return text
    .replace(ARN, (m) => token("arn", m, rev))
    .replace(EMAIL, (m) => token("email", m, rev))
    .replace(ACCOUNT, (_m, prefix: string, id: string) => `${prefix}${token("acct", id, rev)}`)
    .replace(IPV4, (m) => (NOT_AN_ADDRESS.test(m) ? m : token("ip", m, rev)))
    .replace(HOST, (m, host: string, tld: string) => (isMaskableHost(host, tld) ? token("host", m, rev) : m));
}

const unmaskText = (text: string, rev: Map<string, string>): string => text.replace(TOKEN, (t) => rev.get(t) ?? t);

function deep(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, f)]));
  return v;
}

function mapBlock(b: ContentBlock, f: (s: string) => string): ContentBlock {
  return {
    ...b,
    ...(b.text !== undefined ? { text: f(b.text) } : {}),
    ...(b.content !== undefined ? { content: f(b.content) } : {}),
    ...(b.reasoning !== undefined ? { reasoning: f(b.reasoning) } : {}),
    ...(b.input !== undefined ? { input: deep(b.input, f) as Record<string, unknown> } : {}),
  };
}

/** Wraps any LLM client: masked on the way out, restored on the way back. Never mutates its input. */
export function maskingClient(inner: LLMClient): LLMClient {
  return {
    chat: async (messages, tools, systemPrompt): Promise<LLMResponse> => {
      const rev = new Map<string, string>();
      const mask = (s: string) => maskText(s, rev);
      const masked: Message[] = messages.map((msg) => ({
        ...msg,
        content: typeof msg.content === "string" ? mask(msg.content) : msg.content.map((b) => mapBlock(b, mask)),
      }));
      const res = await inner.chat(masked, tools, systemPrompt);
      const unmask = (s: string) => unmaskText(s, rev);
      return { ...res, content: res.content.map((b) => mapBlock(b, unmask)) };
    },
    ...(inner.shutdown ? { shutdown: inner.shutdown.bind(inner) } : {}),
  };
}
