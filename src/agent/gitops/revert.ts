import type { ChangeTimeline, TimelineCommit } from "../changes/index.js";

// The commit a revert PR undoes. Picked HERE from the change timeline the agent collected, never
// taken from the model's proposal: a sha in model output is an unverified Git target, and the
// timeline is the only place a commit is known to have touched this HelmRelease in the window.
export function pickRevertCommit(timeline: ChangeTimeline | null, helmRelease: string): TimelineCommit | null {
  const mine = (timeline?.commits ?? []).filter((c) => c.helmRelease === helmRelease);
  return [...mine].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}
