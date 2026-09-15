import { test } from "node:test";
import assert from "node:assert/strict";
import { resourceEvidenceRefusal } from "./evidence-guard.js";

const events = (...lines: string[]) => lines.join("\n");

// C03: a container running `sleep 3; exit 1`. It restarts forever, prints nothing, and its events
// say only that it backed off. Two attempts out of three proposed a memory limit anyway.
test("a resource change is refused when the events show no resource fault", () => {
  const why = resourceEvidenceRefusal(
    "k8s_set_resources",
    events("BackOff: Back-off restarting failed container worker", "Pulled: Container image busybox:1.36 already present")
  );
  assert.match(why ?? "", /nothing in the namespace's events says it is/);
  assert.match(why ?? "", /infinite memory ratio/);
});

test("an OOMKill, an eviction, throttling or an unsatisfiable request all let it through", () => {
  for (const line of [
    "OOMKilling: Memory cgroup out of memory: Killed process 1",
    "Evicted: The node was low on resource: memory",
    "FailedScheduling: 0/3 nodes are available: 3 Insufficient cpu",
    "container has been CPU throttled for 40% of the period",
    "Container worker exited with exit code 137",
  ]) {
    assert.equal(resourceEvidenceRefusal("k8s_set_resources", events(line)), null, line);
  }
});

test("no other action is this guard's business", () => {
  const quiet = events("BackOff: Back-off restarting failed container worker");
  for (const a of ["k8s_rollout_restart", "k8s_delete_pod", "k8s_set_image", "k8s_scale"]) {
    assert.equal(resourceEvidenceRefusal(a, quiet), null, a);
  }
});

// A refusal built on a failed tool call is a guess wearing a guard's clothes.
test("an empty read proves nothing and refuses nothing", () => {
  assert.equal(resourceEvidenceRefusal("k8s_set_resources", ""), null);
  assert.equal(resourceEvidenceRefusal("k8s_set_resources", "   \n  "), null);
});

// The bare number appears in port numbers and byte counts; only the phrase is evidence.
test("a bare 137 is not an exit code, so it is not evidence and does not open the gate", () => {
  for (const line of ["Started container on port 13700", "read 137 bytes from the socket"]) {
    assert.match(resourceEvidenceRefusal("k8s_set_resources", events(line)) ?? "", /nothing in the namespace/, line);
  }
  // the phrase is
  assert.equal(resourceEvidenceRefusal("k8s_set_resources", events("terminated with exit code 137")), null);
});
