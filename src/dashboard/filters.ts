export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export interface Filters {
  from: Date | null;
  to: Date | null;
  alertname: string | null;
  namespace: string | null;
  severity: string | null;
  resolved: boolean | null;
  page: number;
  pageSize: number;
}

const str = (p: URLSearchParams, k: string): string | null => {
  const v = p.get(k)?.trim();
  return v ? v : null;
};

const date = (p: URLSearchParams, k: string): Date | null => {
  const v = str(p, k);
  if (!v) return null;
  const d = new Date(v);
  // an Invalid Date would reach Postgres and error at query time — drop it here instead
  return Number.isFinite(d.getTime()) ? d : null;
};

const int = (p: URLSearchParams, k: string, fallback: number): number => {
  const n = parseInt(p.get(k) ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export function parseFilters(params: URLSearchParams): Filters {
  const resolved = str(params, "resolved");
  return {
    from: date(params, "from"),
    to: date(params, "to"),
    alertname: str(params, "alertname"),
    namespace: str(params, "namespace"),
    severity: str(params, "severity"),
    // absent means "either" — distinct from an explicit false
    resolved: resolved === null ? null : resolved === "true",
    page: Math.max(1, int(params, "page", 1)),
    // the clamp is a safety rail: an unbounded LIMIT runs on the same event loop as
    // alert handling, and there is no auth in front of this
    pageSize: Math.min(PAGE_SIZE_MAX, Math.max(1, int(params, "pageSize", PAGE_SIZE_DEFAULT))),
  };
}
