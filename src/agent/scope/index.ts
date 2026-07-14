import type { ContentBlock } from "../llm/types.js";

// Conversation-mode namespace scope lock. The FIRST tool round defines which namespaces
// the question is about (the model's initial targeting has always been correct); later
// rounds may not drift into new ones — the model kept chasing anomalies into other
// namespaces no matter what the prompt said. Namespace-less calls (prometheus/loki
// queries) are never blocked; an empty first-round scope disables the lock entirely.

export function namespacesOf(toolUses: ContentBlock[]): Set<string> {
  return new Set(
    toolUses
      .map((t) => (t.input as Record<string, unknown> | undefined)?.namespace)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
  );
}

export function outOfScope(toolUses: ContentBlock[], scope: Set<string>): ContentBlock[] {
  if (scope.size === 0) return [];
  return toolUses.filter((t) => {
    const ns = (t.input as Record<string, unknown> | undefined)?.namespace;
    return typeof ns === "string" && !scope.has(ns);
  });
}
