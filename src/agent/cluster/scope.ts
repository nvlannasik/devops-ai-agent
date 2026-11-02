// Multi-cluster 2b: in a run bound to a cluster, every PromQL/LogQL selector reads that cluster only.
// The central Prometheus and Loki hold every cluster, and both have a node named worker1, so a selector
// without `cluster` mixes them into one answer. The prompt asked for the filter and was not enough:
// 32 of 72 unfiltered queries measured 2026-11-02 came from bound runs. Rewritten, not refused — a
// refusal costs a round and a small model loops on it.
//
// Not a parser: a scanner that knows where selectors can be. Strings are copied verbatim; a `{…}`
// outside a string is a selector in both languages; PromQL also has bare metric names (`up`), which
// are identifiers that are not a keyword, not a function call and not in a `by (…)`/`on (…)` list.
// A selector that already names `cluster` (any operator) is left alone: that is a deliberate read.

const KEYWORDS = new Set(["by", "without", "on", "ignoring", "group_left", "group_right", "bool", "offset", "and", "or", "unless", "atan2", "inf", "nan", "start", "end"]);
const LIST_KEYWORDS = new Set(["by", "without", "on", "ignoring", "group_left", "group_right"]);
const HAS_CLUSTER = /(?:^|[{,])\s*cluster\s*(?:=~|!~|!=|=)/;

/** Index just past the string literal that opens at `i`. An unterminated string runs to the end. */
function endOfString(q: string, i: number): number {
  const quote = q[i];
  let j = i + 1;
  while (j < q.length && q[j] !== quote) j += quote !== "`" && q[j] === "\\" ? 2 : 1;
  return Math.min(j + 1, q.length);
}

/** Index of the `}` closing the `{` at `i`, skipping strings; -1 if none. */
function closeBrace(q: string, i: number): number {
  for (let j = i + 1; j < q.length; ) {
    const c = q[j];
    if (c === '"' || c === "'" || c === "`") j = endOfString(q, j);
    else if (c === "}") return j;
    else j++;
  }
  return -1;
}

function withMatcher(inner: string, matcher: string): string {
  if (HAS_CLUSTER.test(`{${inner}`)) return inner;
  return inner.trim() ? `${matcher}, ${inner.trimStart()}` : matcher;
}

/** `query` with `cluster="<cluster>"` in every selector. Unchanged when every selector already names one. */
export function scopeQuery(query: string, cluster: string, lang: "promql" | "logql"): string {
  const matcher = `cluster="${cluster}"`;
  let out = "";
  let i = 0;
  while (i < query.length) {
    const c = query[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const j = endOfString(query, i);
      out += query.slice(i, j);
      i = j;
    } else if (c === "{") {
      const j = closeBrace(query, i);
      if (j < 0) return query; // malformed: let the backend say so, on the model's own text
      out += `{${withMatcher(query.slice(i + 1, j), matcher)}}`;
      i = j + 1;
    } else if (lang === "logql") {
      out += c;
      i++;
    } else if (c === "[") {
      // A range or subquery: durations and steps, no selectors.
      const j = query.indexOf("]", i);
      const end = j < 0 ? query.length : j + 1;
      out += query.slice(i, end);
      i = end;
    } else if (/[0-9.]/.test(c)) {
      // A number or a duration — consumed whole, so the `m` of `5m` or the `e` of `1e3` is no metric.
      const tok = /^[0-9.]+(?:[eE][+-]?[0-9]+)?[A-Za-z0-9_]*/.exec(query.slice(i))![0];
      out += tok;
      i += tok.length;
    } else if (/[A-Za-z_:]/.test(c)) {
      const id = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(query.slice(i))![0];
      i += id.length;
      out += id;
      const ws = /^\s*/.exec(query.slice(i))![0];
      const next = query[i + ws.length];
      const word = id.toLowerCase();
      if (LIST_KEYWORDS.has(word) && next === "(") {
        // A label list: names, not metrics.
        const j = query.indexOf(")", i);
        const end = j < 0 ? query.length : j + 1;
        out += query.slice(i, end);
        i = end;
      } else if (!KEYWORDS.has(word) && next !== "(" && next !== "{" && !/^\s*(?:by|without)\s*\(/i.test(query.slice(i))) {
        // (`sum by (pod) (…)`: an aggregation whose modifier comes first, not a metric named `sum`.)
        out += `{${matcher}}`; // a bare metric name
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The query language a tool's `query` argument is in, or null when the tool takes none. */
export function queryLanguage(tool: string): "promql" | "logql" | null {
  if (/^prometheus_query(_range)?$/.test(tool)) return "promql";
  if (/^loki_(query|query_range|get_streams|get_stats)$/.test(tool)) return "logql";
  return null;
}
