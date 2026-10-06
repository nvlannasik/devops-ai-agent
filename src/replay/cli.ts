// npm run replay -- [<case>] [--mode gates|tools] [--attempts N] [--live proposal]
//
// gates (default): offline and deterministic — what `npm test` runs. tools: the model is live (the
// LLM_* env, same as the bench) and the cluster is the recording; reports pass^k per case.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createLLMClient } from "../agent/llm/index.js";
import { readCase } from "./trace.js";
import { replay, score } from "./run.js";
import type { Mode, Phase } from "./fakes.js";

// REPLAY_CASES_DIR: the compiled copy in dist/ cannot find replay/cases relative to itself.
const DIR = process.env.REPLAY_CASES_DIR ?? fileURLToPath(new URL("../../replay/cases", import.meta.url));
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const mode = (flag("mode") ?? "gates") as Mode;
if (mode !== "gates" && mode !== "tools") throw new Error("--mode must be gates or tools");
// --live proposal: only the proposal step asks the live model; the investigation is the recording.
const livePhases = flag("live")?.split(",") as Phase[] | undefined;
if (livePhases?.some((p) => p !== "proposal" && p !== "investigate")) throw new Error("--live takes proposal and/or investigate");
const attempts = Number(flag("attempts") ?? (mode === "tools" ? 3 : 1));
if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("--attempts must be a positive integer");

const names = (existsSync(DIR) ? readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []).filter(
  (n) => !only || n === only
);
if (names.length === 0) throw new Error(only ? `no case named ${only}` : `no cases under ${DIR}`);

const live = mode === "tools" ? createLLMClient() : undefined;
let failed = 0;
for (const name of names) {
  const c = readCase(join(DIR, name));
  let passed = 0;
  for (let n = 1; n <= attempts; n++) {
    const r = await replay(c.trace, { mode, live, livePhases });
    const s = score(r, c.expect);
    if (mode === "tools") console.log(`  ${name} #${n}: proposal ${JSON.stringify(r.proposal ?? null)} gates ${r.gates.filter((g) => g.startsWith("remediation-") || g.startsWith("proposal")).join(",") || "-"}`);
    // The RCA's first action is what the proposal converts, so a prompt experiment reads it here.
    if (mode === "tools") console.log(`  ${name} #${n}: immediate ${r.answer.match(/\*Immediate:\*\s*(.*)/)?.[1]?.slice(0, 300) ?? "-"}`);
    if (s.outcome === "passed") passed++;
    else console.log(`  ${name} #${n}: ${s.outcome} — ${s.why.join("; ")}`);
  }
  if (passed < attempts) failed++;
  console.log(`${passed === attempts ? "PASS" : "FAIL"} ${name} ${passed}/${attempts} (${mode})`);
}
await live?.shutdown?.();
process.exit(failed > 0 ? 1 : 0);
