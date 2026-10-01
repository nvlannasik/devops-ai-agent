// npm run replay -- [<case>] [--mode gates|tools] [--attempts N]
//
// gates (default): offline and deterministic — what `npm test` runs. tools: the model is live (the
// LLM_* env, same as the bench) and the cluster is the recording; reports pass^k per case.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createLLMClient } from "../agent/llm/index.js";
import { readCase } from "./trace.js";
import { replay, score } from "./run.js";
import type { Mode } from "./fakes.js";

const DIR = fileURLToPath(new URL("../../replay/cases", import.meta.url));
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const mode = (flag("mode") ?? "gates") as Mode;
if (mode !== "gates" && mode !== "tools") throw new Error("--mode must be gates or tools");
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
    const s = score(await replay(c.trace, { mode, live }), c.expect);
    if (s.outcome === "passed") passed++;
    else console.log(`  ${name} #${n}: ${s.outcome} — ${s.why.join("; ")}`);
  }
  if (passed < attempts) failed++;
  console.log(`${passed === attempts ? "PASS" : "FAIL"} ${name} ${passed}/${attempts} (${mode})`);
}
await live?.shutdown?.();
process.exit(failed > 0 ? 1 : 0);
