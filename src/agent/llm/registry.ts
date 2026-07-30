import { ClaudeClient } from "./claude.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { SQSLLMClient } from "./sqs.js";
import type { LLMClient } from "./types.js";

// Backends are declared with indexed env vars — LLM_BACKEND_<N>_<FIELD>. The backend NAME is
// a value, never part of a key, so adding one never means inventing new key names. Each field
// being its own env var is the point: _KEY comes from a Secret while the rest come from a
// ConfigMap, which a single JSON blob could not do without dragging the whole blob into the
// Secret. Routes reference NAME, so renumbering indices never breaks routing.
export type BackendKind = "claude" | "openai-compatible" | "private-llm";

export interface BackendSpec {
  name: string;
  kind: BackendKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface Registry {
  backends: BackendSpec[];
  heavy: string[];
  light: string[];
}

const KINDS: BackendKind[] = ["claude", "openai-compatible", "private-llm"];

const splitNames = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Which fields each kind needs. private-llm takes none: its queues and credentials stay in
// config.llm.sqs, shared by every replica.
function assertFields(spec: BackendSpec, i: number): void {
  const missing: string[] = [];
  if (spec.kind === "claude" || spec.kind === "openai-compatible") {
    if (!spec.model) missing.push("MODEL");
    if (!spec.apiKey) missing.push("KEY");
  }
  if (spec.kind === "openai-compatible" && !spec.baseUrl) missing.push("BASE_URL");
  if (missing.length > 0) {
    throw new Error(
      `LLM backend ${i} (kind=${spec.kind}) is missing ` +
      missing.map((m) => `LLM_BACKEND_${i}_${m}`).join(", ")
    );
  }
}

// Everything throws here rather than at first request: an env-var typo must show up as a pod
// that refuses to start, not as the first alert of the day failing.
export function parseRegistry(env: NodeJS.ProcessEnv): Registry {
  const backends: BackendSpec[] = [];
  for (let i = 1; ; i++) {
    const name = env[`LLM_BACKEND_${i}_NAME`]?.trim();
    if (!name) break;
    const kind = env[`LLM_BACKEND_${i}_KIND`]?.trim() as BackendKind | undefined;
    if (!kind || !KINDS.includes(kind)) {
      throw new Error(
        `LLM_BACKEND_${i}_KIND must be one of ${KINDS.join(", ")} (got ${kind ?? "unset"})`
      );
    }
    if (backends.some((b) => b.name === name)) {
      throw new Error(`duplicate LLM backend name "${name}" at index ${i}`);
    }
    const spec: BackendSpec = {
      name,
      kind,
      model: env[`LLM_BACKEND_${i}_MODEL`],
      baseUrl: env[`LLM_BACKEND_${i}_BASE_URL`],
      apiKey: env[`LLM_BACKEND_${i}_KEY`],
    };
    assertFields(spec, i);
    backends.push(spec);
  }

  if (backends.length === 0) {
    throw new Error("LLM_PROVIDER=router requires at least LLM_BACKEND_1_NAME");
  }

  const heavy = splitNames(env.LLM_ROUTE_HEAVY);
  const light = splitNames(env.LLM_ROUTE_LIGHT);
  if (heavy.length === 0) {
    throw new Error("LLM_ROUTE_HEAVY is required when LLM_PROVIDER=router");
  }
  for (const n of [...heavy, ...light]) {
    if (!backends.some((b) => b.name === n)) {
      throw new Error(`LLM_ROUTE_* references unknown backend "${n}"`);
    }
  }

  return { backends, heavy, light };
}

export function buildBackends(specs: BackendSpec[]): Map<string, LLMClient> {
  const out = new Map<string, LLMClient>();
  for (const s of specs) {
    if (s.kind === "claude") {
      out.set(s.name, new ClaudeClient({ apiKey: s.apiKey, model: s.model }));
    } else if (s.kind === "openai-compatible") {
      out.set(s.name, new OpenAICompatibleClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model }));
    } else {
      out.set(s.name, new SQSLLMClient());
    }
  }
  return out;
}
