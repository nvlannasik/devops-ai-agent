import express, { type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { VmStore, VmStatus } from "../agent/vm/store.js";
import logger, { errDetail } from "../utils/logger/index.js";

// The VM agent's three routes (spec 2026-11-04 Part B). The caller IS the VM its token names —
// a body that says otherwise is ignored, so one VM can never see or answer another's actions.
type Deps = {
  tokens: Map<string, string>;
  store: Pick<VmStore, "heartbeat" | "claim" | "finish">;
  onResult: (host: string, id: number, remediationId: number | null, result: Record<string, unknown>) => Promise<void>;
};

const digest = (s: string) => createHash("sha256").update(s).digest();

/** The VM name whose token this is, compared in constant time over digests (no length leak). */
function vmOf(tokens: Map<string, string>, header: string | undefined): string | null {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!given) return null;
  for (const [name, token] of tokens) if (timingSafeEqual(digest(given), digest(token))) return name;
  return null;
}

const STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "refused"]);

export function vmRoutes(deps: Deps): express.Router {
  const router = express.Router();
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const vm = vmOf(deps.tokens, req.headers.authorization);
    if (!vm) return void res.status(401).end();
    res.locals.vm = vm;
    next();
  };
  const fail = (res: Response, what: string) => (err: unknown) => {
    logger.warn(`[vm] ${what} failed: ${errDetail(err)}`);
    res.status(500).end();
  };

  router.post("/vm/heartbeat", auth, (req, res) => {
    const units = Array.isArray(req.body?.units) ? req.body.units.filter((u: unknown): u is string => typeof u === "string") : [];
    deps.store.heartbeat(res.locals.vm, units, String(req.body?.version ?? "")).then(() => res.status(204).end(), fail(res, "heartbeat"));
  });

  router.post("/vm/actions/claim", auth, (_req, res) => {
    deps.store.claim(res.locals.vm).then((a) => (a ? res.status(200).json(a) : res.status(204).end()), fail(res, "claim"));
  });

  router.post("/vm/actions/:id/result", auth, (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status ?? "");
    if (!Number.isInteger(id) || !STATUSES.has(status)) return void res.status(400).end();
    const result = (req.body ?? {}) as Record<string, unknown>;
    deps.store
      .finish(id, res.locals.vm, status as VmStatus, result)
      .then(async (row) => {
        if (!row) return void res.status(404).end();
        res.status(204).end();
        await deps.onResult(res.locals.vm, id, row.remediationId, result).catch((err) => logger.warn(`[vm] posting the result of action ${id} failed: ${errDetail(err)}`));
      }, fail(res, "result"));
  });

  return router;
}
