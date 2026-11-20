import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SnapshotCandidate } from "../agent/vm/store.js";
import type { StoredPoint } from "../agent/vm/history.js";

const run = promisify(execFile);

// The bench runs with no DB_HOST on purpose — its incidents must not land in production's incident
// memory — so its VmStore is the no-pool one and node_host_snapshot would answer "no agent reports
// here" for every node. Case C15 is about exactly that tool (etcd outside pods on a control plane),
// so with BENCH_HOST_SNAPSHOTS=kubectl the bench reads the PRODUCTION agent's vm_hosts instead,
// through the agent pod (`kubectl exec`, its own DB credentials, nothing copied out but the rows
// asked for). Read-only: there is no write here, and restarts (enqueue) are refused.

const QUERY = `
const {Pool}=require("pg");
const p=new Pool({host:process.env.DB_HOST,port:+(process.env.DB_PORT||5432),user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_NAME||"devops_agent"});
p.query("SELECT name, cluster, node, snapshot, version, extract(epoch FROM now() - snapshot_at)::int AS age FROM vm_hosts WHERE COALESCE(node, name) = $1 OR name = $1 ORDER BY name",[process.argv[1]])
 .then(r=>{process.stdout.write(JSON.stringify(r.rows));return p.end()})
 .catch(e=>{process.stderr.write(e.message);process.exit(1)});`;

const HISTORY_QUERY = `
const {Pool}=require("pg");
const p=new Pool({host:process.env.DB_HOST,port:+(process.env.DB_PORT||5432),user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_NAME||"devops_agent"});
p.query("SELECT at, point FROM vm_host_history WHERE host = $1 AND at > now() - make_interval(hours => $2) ORDER BY at",[process.argv[1],+process.argv[2]])
 .then(r=>{process.stdout.write(JSON.stringify(r.rows));return p.end()})
 .catch(e=>{process.stderr.write(e.message);process.exit(1)});`;

export class KubectlHostSnapshots {
  constructor(
    private readonly namespace = process.env.BENCH_AGENT_NAMESPACE ?? "devops-tools",
    private readonly target = process.env.BENCH_AGENT_TARGET ?? "deploy/devops-ai-agent"
  ) {}

  async snapshotCandidates(node: string): Promise<SnapshotCandidate[]> {
    const { stdout } = await run("kubectl", ["-n", this.namespace, "exec", this.target, "--", "node", "-e", QUERY, node], { timeout: 30_000, maxBuffer: 4 << 20 });
    const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: String(r.name),
      cluster: (r.cluster as string | null) ?? null,
      node: (r.node as string | null) ?? null,
      snapshot: (r.snapshot as Record<string, unknown> | null) ?? null,
      ageSeconds: r.age === null || r.age === undefined ? null : Number(r.age),
      version: (r.version as string | null) ?? null,
    }));
  }

  /** node_host_history's points, from production's vm_host_history (read-only, like the snapshot). */
  async history(host: string, hours: number): Promise<StoredPoint[]> {
    const { stdout } = await run("kubectl", ["-n", this.namespace, "exec", this.target, "--", "node", "-e", HISTORY_QUERY, host, String(hours)], { timeout: 30_000, maxBuffer: 16 << 20 });
    return (JSON.parse(stdout) as Array<{ at: string; point: StoredPoint["point"] }>).map((r) => ({ at: new Date(r.at), point: r.point }));
  }

  // The restart tool's half: the bench never queues a host action.
  async registered(): Promise<null> {
    return null;
  }
  async enqueue(): Promise<null> {
    return null;
  }
}
