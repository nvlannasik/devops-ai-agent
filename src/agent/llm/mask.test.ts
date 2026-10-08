import { test } from "node:test";
import assert from "node:assert/strict";
import { maskingClient, maskText } from "./mask.js";
import type { LLMClient, Message, LLMResponse } from "./types.js";

// Credential-ish identifiers never leave the agent in clear: IPs, emails, AWS ARNs and account ids,
// hostnames. Everything the model returns is restored before the loop sees it, so tools, memory,
// trace, grounding and Slack all keep the real values (decision 2026-10-08, every backend).

test("IPs, emails, ARNs, account ids and hostnames become stable tokens", () => {
  const rev = new Map<string, string>();
  const s = maskText(
    "pod 10.42.2.152 called api.example-corp.cloud; owner ops@example-corp.cloud; role arn:aws:iam::123456789012:role/agent; aws account id: 210987654321",
    rev
  );
  assert.doesNotMatch(s, /10\.42\.2\.152|example-corp\.cloud|ops@|arn:aws|123456789012|210987654321/);
  assert.match(s, /ip-[0-9a-f]{6}/);
  assert.match(s, /host-[0-9a-f]{6}/);
  assert.match(s, /email-[0-9a-f]{6}/);
  assert.match(s, /arn-[0-9a-f]{6}/);
  assert.match(s, /aws account id: acct-[0-9a-f]{6}/);
  // the same value is the same token in a second, independent call — the model stays coherent
  assert.equal(maskText("10.42.2.152", new Map()), maskText("10.42.2.152", new Map()));
});

test("what the model needs to reason with is left alone", () => {
  const keep = [
    "app.kubernetes.io/name", "helm.toolkit.fluxcd.io/name", "k8s.io/client-go@v0.35.2", "helm.sh/chart",
    "cert-manager.io/cluster-issuer", "ghcr.io/x/storefront:1.4.2", "docker.io/library/nginx", "quay.io/jetstack/cert-manager-controller:v1.20.2",
    "orders-api.sample-apps.svc.cluster.local", "cr.fluentbit.io/fluent/fluent-bit:3.1", "values.yaml", "release.yaml", "index.ts", "nginx.conf",
    "http_server_requests_total", "memory 134217728000 bytes", "checkout-gateway-6b747db7c9-zwdcv", "v1.27.0",
  ];
  for (const k of keep) assert.equal(maskText(k, new Map()), k, k);
});

// Found by masking a live pod, its events and the nodes (2026-10-08): these were tokenised. None is
// a secret, and two carry the diagnosis — "refused 127.0.0.1:5432" is an app pointed at localhost,
// "listening on 0.0.0.0" is a bind address — which a token erases.
test("loopback, the unspecified address and the cluster's own label domains are left alone", () => {
  const keep = [
    "dial tcp 127.0.0.1:5432: connect: connection refused", "listening on 0.0.0.0:8080", "127.0.1.1",
    "k3s.io/hostname", "node.k3s.io/instance-type", "flannel.alpha.coreos.com/public-ip",
    "wrangler.cattle.io/finalizer", "driver.longhorn.io",
  ];
  for (const k of keep) assert.equal(maskText(k, new Map()), k, k);
  // the neighbours of the exemption are still masked
  assert.match(maskText("pod 10.42.2.224 and node 10.10.10.3", new Map()), /^pod ip-[0-9a-f]{6} and node ip-[0-9a-f]{6}$/);
});

const fakeInner = (seen: Message[][]): LLMClient => ({
  chat: async (messages) => {
    seen.push(messages);
    const text = JSON.stringify(messages);
    const ip = /ip-[0-9a-f]{6}/.exec(text)![0];
    const host = /host-[0-9a-f]{6}/.exec(text)![0];
    return {
      content: [
        { type: "text", text: `the pod at ${ip} cannot reach ${host}` },
        { type: "tool_use", id: "t1", name: "k8s_list_pods", input: { note: `check ${ip}`, nested: { h: host } } },
      ],
      stopReason: "tool_use",
    } as LLMResponse;
  },
});

test("the wrapped client masks what it sends and restores what comes back, tool inputs included", async () => {
  const seen: Message[][] = [];
  const client = maskingClient(fakeInner(seen));
  const history: Message[] = [
    { role: "user", content: "why is 10.42.2.152 failing?" },
    { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "k8s_get", input: { host: "api.example-corp.cloud" } }] as any },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "upstream api.example-corp.cloud refused 10.42.2.152" }] as any },
  ];
  const out = await client.chat(history, [], "system prompt stays as written: example.com");
  const sent = JSON.stringify(seen[0]);
  assert.doesNotMatch(sent, /10\.42\.2\.152|example-corp\.cloud/, "nothing credential-ish crosses the wire");
  assert.equal((out.content[0] as any).text, "the pod at 10.42.2.152 cannot reach api.example-corp.cloud");
  assert.deepEqual((out.content[1] as any).input, { note: "check 10.42.2.152", nested: { h: "api.example-corp.cloud" } });
  assert.equal(JSON.stringify(history[0]), JSON.stringify({ role: "user", content: "why is 10.42.2.152 failing?" }), "the caller's history is not mutated");
});

test("a token the model invents is left as written, not guessed", async () => {
  const client = maskingClient({ chat: async () => ({ content: [{ type: "text", text: "see ip-ffffff" }], stopReason: "end_turn" }) as LLMResponse });
  const out = await client.chat([{ role: "user", content: "hi" }], [], "");
  assert.equal((out.content[0] as any).text, "see ip-ffffff");
});
