import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import logger from "../utils/logger/index.js";

// The two files `scripts/build-client.mjs` emits, and the only static assets this server has
// ever had. Everything else on this dashboard is a string built in a request handler.
//
// Read ONCE at construction, into memory. They are ~440 KB together, they cannot change while
// the process lives (the bundle is baked into the image), and reading from disk per request
// would put an fs call on a path whose whole point is being cacheable. This also means a
// missing bundle is discovered at boot and logged there, not as a 404 someone finds later.

const FILES = [
  { name: "topology.js", type: "text/javascript; charset=utf-8" },
  { name: "topology.css", type: "text/css; charset=utf-8" },
] as const;

export interface Asset {
  /** The URL this asset is served at, hash included. */
  path: string;
  body: string;
  type: string;
}

export interface Assets {
  js: Asset;
  css: Asset;
  byPath: Map<string, Asset>;
}

/**
 * Resolves the package root by walking up for package.json, rather than counting `..` segments
 * from import.meta.url. The count differs between the two ways this module runs — `src/…` under
 * tsx in dev, `dist/src/…` after tsc in the image — and a path that is correct in exactly one
 * of them is the kind of thing that works locally and 404s in the cluster.
 */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Loads the client bundle, or returns null if it has not been built.
 *
 * Null is a supported state, not a failure to handle: `npm run dev` runs tsx against the source
 * and does not bundle, so a developer who has never run `npm run build` gets the topology page
 * with its tables and an honest line saying the map is not built — rather than a page that
 * silently renders an empty frame, or a boot that fails over a dashboard (design §8: the
 * dashboard is the one component that may not stop the pod).
 */
export function loadAssets(): Assets | null {
  const root = packageRoot();
  if (!root) {
    logger.warn("[dashboard] could not resolve the package root; the topology map will not be served");
    return null;
  }

  const dir = join(root, "dist", "public");
  const loaded: Asset[] = [];
  for (const f of FILES) {
    const file = join(dir, f.name);
    if (!existsSync(file)) {
      logger.warn(
        `[dashboard] client bundle missing (${file}) — the topology map will render as a note. ` +
          `Run \`npm run build:client\`.`
      );
      return null;
    }
    const body = readFileSync(file, "utf8");
    // Content-addressed so the response can be cached forever and a new build is a new URL.
    // Eight hex chars is 32 bits: these are two files that change together, not a namespace
    // where a collision has anything to collide with.
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
    const [base, ext] = f.name.split(".") as [string, string];
    loaded.push({ path: `/assets/${base}.${hash}.${ext}`, body, type: f.type });
  }

  const [js, css] = loaded as [Asset, Asset];
  return { js, css, byPath: new Map(loaded.map((a) => [a.path, a])) };
}
