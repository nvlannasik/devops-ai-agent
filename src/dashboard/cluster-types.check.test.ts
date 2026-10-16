import { test } from "node:test";
import type { ClusterModel } from "../agent/onboarding/types.js";
import type { DashboardClusterModel } from "./cluster-types.js";

// The dashboard never imports agent types at runtime; this compile-time check is what keeps the
// structural mirror honest — tsc fails here if the two drift apart.
test("the dashboard's model mirror accepts the agent's model", () => {
  const assign = (m: ClusterModel): DashboardClusterModel => m;
  void assign;
});
