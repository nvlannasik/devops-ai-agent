// Shared test fixture for Tasks 1-2 (postmortem-draft, 2026-10-14). Not imported by production
// code — incident #7, SampleAppHighLatency in sample-apps: a TIMEOUT_MS spec-change broke
// checkout-gateway, one remediation rolled it back and recovered, resolved by alertmanager.
import type { PostmortemFacts } from "./facts.js";

export const FIXTURE: PostmortemFacts = {
  incident: {
    id: 7,
    alertname: "SampleAppHighLatency",
    namespace: "sample-apps",
    severity: "high",
    assessedSeverity: "high",
    alertStartedAt: "2026-10-14T10:00:00.000Z",
    createdAt: "2026-10-14T10:00:05.000Z",
    resolvedAt: "2026-10-14T10:20:00.000Z",
    resolvedBy: "alertmanager",
    rootCause: "checkout-gateway TIMEOUT_MS was lowered from 2000ms to 50ms in a spec change",
    rca: "*📍 Root Cause*\nThe `checkout-gateway` Deployment's `TIMEOUT_MS` was lowered from 2000 to 50, so calls to orders-api timed out under normal latency.",
  },
  changes: {
    namespace: "sample-apps",
    window: { from: "2026-10-13T10:00:00.000Z", to: "2026-10-14T10:00:00.000Z" },
    changes: [
      {
        at: "2026-10-14T09:50:00.000Z",
        source: "cluster",
        kind: "spec-change",
        workload: "Deployment/checkout-gateway",
        revision: "5",
        diff: [{ field: "api.env.TIMEOUT_MS", from: "2000", to: "50" }],
      },
    ],
    commits: [],
    unread: [],
    subjects: ["checkout-gateway"],
  },
  remediations: [
    {
      action: "rollback",
      summary: "revert checkout-gateway TIMEOUT_MS to 2000",
      status: "succeeded",
      approvedBy: "U1",
      createdAt: "2026-10-14T10:05:00.000Z",
      executedAt: "2026-10-14T10:08:00.000Z",
      verdict: "recovered",
      result: null,
    },
  ],
  related: [
    {
      id: 8,
      alertname: "SampleAppHighLatency",
      subjects: ["checkout-gateway"],
      createdAt: "2026-10-14T10:06:00.000Z",
      resolvedAt: null,
    },
  ],
  confirmed: [],
  humans: ["the timeout change was mine, reverting"],
  investigation: { startedAt: "2026-10-14T10:01:00.000Z", endedAt: "2026-10-14T10:04:00.000Z" },
  unavailable: [],
};
