// One page is ten rows, everywhere, and it is not adjustable. Page size is not a filter: a
// filter narrows which incidents you are looking at, paging only moves through them, and a
// per-page control in the filter bar mixed the two — it needed Apply to take effect and it
// sat nowhere near the pager it governed. Ten fits on a laptop screen without scrolling.
export const PAGE_SIZE = 10;
const PAGE_MAX = 1000000; // a safe integer that exceeds any reasonable pagination need

export interface Filters {
  from: Date | null;
  to: Date | null;
  alertname: string | null;
  namespace: string | null;
  severity: string | null;
  resolved: boolean | null;
  page: number;
}

const str = (p: URLSearchParams, k: string): string | null => {
  const v = p.get(k)?.trim();
  if (!v) return null;
  // strip control characters (0x00-0x1F except tab 0x09, LF 0x0A, CR 0x0D already removed by trim)
  // control bytes in text parameters error at Postgres: "invalid byte sequence for encoding"
  const cleaned = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return cleaned ? cleaned : null;
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

const resolveBool = (p: URLSearchParams, k: string): boolean | null => {
  const v = p.get(k)?.trim().toLowerCase();
  if (!v) return null; // absent or empty
  // recognise truthy and falsy values case-insensitively
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  // anything else (unrecognised value) → null, never collapsing to a default bool that
  // contradicts the intent. a typo in the URL must not silently change the query.
  return null;
};

export function parseFilters(params: URLSearchParams): Filters {
  return {
    from: date(params, "from"),
    to: date(params, "to"),
    alertname: str(params, "alertname"),
    namespace: str(params, "namespace"),
    severity: str(params, "severity"),
    // absent means "either" — distinct from an explicit false. unrecognised values also
    // collapse to null (no filter), never to a boolean that contradicts the intent.
    resolved: resolveBool(params, "resolved"),
    // page is a safe integer, clamped to a reasonable upper bound to avoid Postgres
    // bigint overflow on OFFSET. unreasonable values (NaN, Infinity, too large) fall
    // back to 1, like other invalid pagination params.
    page: Math.max(1, Math.min(PAGE_MAX, int(params, "page", 1))),
  };
}

// The overview's time range. Three fixed steps, not a free-form interval: every one of them is
// a bucket size as well as a length — 24h is read per hour, a week and a month per day — and a
// range someone can type is a range with no series that fits it.
//
// The value reaches SQL as TWO bound parameters (the interval and the date_trunc field), never
// as interpolated text; RANGES in queries.ts is what maps a step to them. parseRange is the
// gate that keeps the key inside the three literals, so a `?range=` from the URL can only ever
// select one of them.
export const RANGES = ["24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = "30d";

export function parseRange(params: URLSearchParams): Range {
  const v = params.get("range")?.trim().toLowerCase();
  // An unrecognised value falls back rather than erroring: a stale bookmark should still show
  // the page, and there is no destructive reading of "the default window".
  return (RANGES as readonly string[]).includes(v ?? "") ? (v as Range) : DEFAULT_RANGE;
}
