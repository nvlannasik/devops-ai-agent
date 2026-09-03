// Bundles the dashboard's one client-side entry (the React Flow dependency map) into
// dist/public/. Run by `npm run build` after tsc, and by `npm run build:client` on its own.
//
// esbuild rather than a bundler with a config file and a plugin ecosystem: this repo has one
// entry point, no framework conventions to satisfy, and esbuild was already in the tree as
// tsx's own dependency. The whole build is the object below.
//
// Output goes to dist/public/ so the Dockerfile needs no change at all — its builder stage
// already runs `npm run build` and its runtime stage already copies dist/.

import { build } from "esbuild";
import { execFile } from "node:child_process";
import { appendFile, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist", "public");

// The bundle is served to a browser, and the module graph that reaches it is not obvious by
// inspection — `topology-graph.ts` imports from `topology-types.ts` precisely so that it does
// NOT reach config/index.js, and that is a one-character edit away from being untrue. These
// are strings that only exist in the server's config surface: if one appears in the bundle,
// something has pulled the config module in and the build fails rather than shipping it.
const FORBIDDEN = [
  "DASHBOARD_PASSWORD",
  "SLACK_BOT_TOKEN",
  "ANTHROPIC_API_KEY",
  "MCP_AUTH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];

await rm(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(root, "src", "dashboard", "client", "topology.tsx")],
  outdir,
  entryNames: "topology",
  bundle: true,
  minify: true,
  // iife, not esm: a classic script needs no `type="module"`, no CORS considerations for a
  // same-origin file, and carries the response's nonce exactly the same way. There is one
  // entry and nothing imports it, so a module format would buy nothing.
  format: "iife",
  target: ["es2022"],
  platform: "browser",
  // React reads process.env.NODE_ENV and `process` does not exist in a browser. Without this
  // the bundle throws on load rather than at build time.
  define: { "process.env.NODE_ENV": '"production"' },
  // @xyflow/react ships its stylesheet as a CSS import from the entry; esbuild emits it as a
  // sibling file, which is why the server serves two assets rather than one.
  loader: { ".css": "css" },
  jsx: "automatic",
  logLevel: "warning",
  metafile: true,
});

const js = await readFile(path.join(outdir, "topology.js"), "utf8");
for (const needle of FORBIDDEN) {
  if (js.includes(needle)) {
    throw new Error(
      `client bundle contains ${needle} — a client module has imported the server's config. ` +
        `See the note at the top of src/dashboard/topology-types.ts.`
    );
  }
}

// Tailwind runs AFTER esbuild and its output is APPENDED to the stylesheet esbuild produced.
// Both halves of that are deliberate:
//   - after, because appending puts the utilities last in the file, so they win over React
//     Flow's own defaults at equal specificity without anyone writing !important;
//   - appended rather than emitted as a third asset, because the page links one stylesheet and
//     a second <link> would be another round trip and another path to hash and to serve.
// The CLI is a separate process rather than a PostCSS plugin because esbuild does not run
// PostCSS, and building a plugin to make it would be more machinery than one exec.
const css = path.join(outdir, "topology.css");
const tw = await run(
  "npx",
  ["@tailwindcss/cli", "-i", path.join(root, "src/dashboard/client/tailwind.css"), "-o", "-"],
  { cwd: root, maxBuffer: 32 * 1024 * 1024 }
);
await appendFile(css, `\n${tw.stdout}`);

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
const cssBytes = (await readFile(css)).length;
console.log(
  `[build:client] dist/public — js ${(bytes / 1024).toFixed(0)} KB, css ${(cssBytes / 1024).toFixed(0)} KB (Tailwind appended)`
);
