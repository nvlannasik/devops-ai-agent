/**
 * An Alertmanager silence for the length of a bench run.
 *
 * Every case injects a real fault and the dev cluster's alert rules have no namespace selector,
 * so an unsilenced run pages the PRODUCTION agent: a real investigation in the real Slack channel,
 * a real incident row, possibly a real approval card. `bench/README.md` documented the silence as
 * a manual step, and the run that was meant to measure masking (2026-10-08) skipped it and opened
 * incidents 240/242/244. A step a person has to remember is a step that gets forgotten.
 *
 * `amtool` inside the Alertmanager pod, through the same `kubectl` the case hooks already use, so
 * the runner needs no port-forward and no second URL. Not the API server's service proxy: `kubectl
 * create --raw` posts `application/octet-stream`, and Alertmanager answers 415 to anything but
 * JSON (measured). Fails CLOSED — no silence, no run — unless `BENCH_SILENCE=false` says this
 * cluster has no Alertmanager worth silencing.
 */
import { execFileSync } from "node:child_process";

type Kubectl = (args: string[]) => string;
const kubectl: Kubectl = (args) => execFileSync("kubectl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// `<namespace>/<service>:<port>` — the in-cluster Alertmanager the agent's webhook is fed by.
const TARGET = process.env.BENCH_ALERTMANAGER ?? "monitoring/alertmanager:9093";
const amtool = (...args: string[]): string[] => {
  const [ns, svcPort] = TARGET.split("/");
  const [svc, port] = svcPort!.split(":");
  const [sub, verb, ...rest] = args;
  return ["-n", ns!, "exec", `svc/${svc}`, "--", "amtool", sub!, verb!, ...rest, `--alertmanager.url=http://localhost:${port ?? "9093"}`];
};

/** Returns the silence id. Throws when none could be opened — before any fault is injected. */
export function openSilence(durationMs: number, run: Kubectl = kubectl): string {
  let id = "";
  let why = "amtool printed no silence id";
  try {
    // One matcher, and never wider than the bench namespaces: a broader silence hides a real incident.
    id = run(amtool("silence", "add", "namespace=~bench-.*", `--duration=${Math.ceil(durationMs / 60_000)}m`,
      "--author=bench", "--comment=fault injection by npm run bench — do not page the agent")).trim();
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (id) return id;
  throw new Error(
    `could not silence Alertmanager (${TARGET}) for namespace=~bench-.*: ${why}. Every injected fault ` +
      `would page the production agent. Fix access, set BENCH_ALERTMANAGER=<ns>/<svc>:<port>, or ` +
      `BENCH_SILENCE=false if this cluster has no Alertmanager.`
  );
}

/** Never throws: it runs at the end of a run, and the silence expires on its own anyway. */
export function closeSilence(id: string, run: Kubectl = kubectl): void {
  try {
    const args = amtool("silence", "expire");
    run([...args, id]);
  } catch {
    // ends at its endsAt
  }
}
