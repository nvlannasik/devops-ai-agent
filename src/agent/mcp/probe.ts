// npm run mcp:probe -- <cluster> [tool] [json-args] [--expired]
// Checks a cluster's SQS bridge by hand before investigations are pointed at it. In a pod:
//   node dist/src/agent/mcp/probe.js <cluster> …   (MCP_SQS_CLUSTERS must name the cluster)
import { pathToFileURL } from "url";
import { config } from "../../config/index.js";
import { SqsMcpDispatcher } from "./sqs-client.js";

const LIST_TIMEOUT_MS = 15_000;

export async function runProbe(
  argv: string[],
  deps: { dispatcher?: SqsMcpDispatcher; out?: (s: string) => void; err?: (s: string) => void } = {}
): Promise<number> {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const expired = argv.includes("--expired");
  const [cluster, tool, json] = argv.filter((a) => a !== "--expired");
  if (!cluster) {
    err("usage: mcp:probe <cluster> [tool] [json-args] [--expired]");
    return 2;
  }
  const entry = config.mcp.sqs.clusters.find((c) => c.name === cluster);
  if (!entry) {
    err(`cluster "${cluster}" is not in MCP_SQS_CLUSTERS (${config.mcp.sqs.clusters.map((c) => c.name).join(", ") || "empty"})`);
    return 2;
  }
  const dispatcher = deps.dispatcher ?? new SqsMcpDispatcher(config.mcp.sqs.responseQueueName);
  // --expired: a deadline already in the past — the bridge must answer "expired" and run nothing
  const opts = expired ? { deadline: Date.now() - 60_000 } : {};
  const t0 = Date.now();
  try {
    if (!tool) {
      const p = await dispatcher.request(entry.requestQueueName, { op: "list_tools" }, LIST_TIMEOUT_MS, cluster, opts);
      const tools = "tools" in p ? p.tools : [];
      out(`${cluster}: ${tools.length} tool(s) in ${Date.now() - t0}ms`);
      for (const t of tools) out(`  ${t.name}`);
    } else {
      const args = json ? (JSON.parse(json) as Record<string, unknown>) : {};
      const p = await dispatcher.request(entry.requestQueueName, { op: "call_tool", tool, args }, config.mcp.toolTimeoutMs, cluster, opts);
      const content = "content" in p ? p.content : "";
      out(`${cluster} ${tool}: ${"isError" in p && p.isError ? "isError" : "ok"} in ${Date.now() - t0}ms, ${Buffer.byteLength(content, "utf8")} bytes`);
      out(content);
    }
    return 0;
  } catch (e) {
    err(`${cluster}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (!deps.dispatcher) await dispatcher.shutdown();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runProbe(process.argv.slice(2)).then((code) => process.exit(code));
}
