import { test } from "node:test";
import assert from "node:assert/strict";
import { queryLanguage, scopeQuery } from "./scope.js";

const P = (q: string) => scopeQuery(q, "stg", "promql");
const L = (q: string) => scopeQuery(q, "stg", "logql");

test("PromQL: every selector, bare names included, gets the cluster", () => {
  assert.equal(P("up"), 'up{cluster="stg"}');
  assert.equal(P('up{job="x"}'), 'up{cluster="stg", job="x"}');
  assert.equal(P('{__name__=~"fluentbit_.*", pod=~"fluentbit-.*"}'), '{cluster="stg", __name__=~"fluentbit_.*", pod=~"fluentbit-.*"}');
  assert.equal(P("count(up) or count(up == 1)"), 'count(up{cluster="stg"}) or count(up{cluster="stg"} == 1)');
  assert.equal(
    P('sum by (pod) (rate(fluentbit_output_proc_records_total{pod=~"fluentbit-.*"}[5m]))'),
    'sum by (pod) (rate(fluentbit_output_proc_records_total{cluster="stg", pod=~"fluentbit-.*"}[5m]))'
  );
  assert.equal(
    P("histogram_quantile(0.99, sum(rate(http_bucket[5m])) by (le, route))"),
    'histogram_quantile(0.99, sum(rate(http_bucket{cluster="stg"}[5m])) by (le, route))'
  );
  assert.equal(P("a / on(pod) group_left(node) b"), 'a{cluster="stg"} / on(pod) group_left(node) b{cluster="stg"}');
  assert.equal(P("a * on(pod) group_left b"), 'a{cluster="stg"} * on(pod) group_left b{cluster="stg"}');
  assert.equal(P("rate(x[5m] offset 1h) > bool 1e3"), 'rate(x{cluster="stg"}[5m] offset 1h) > bool 1e3');
  assert.equal(P("max_over_time(rate(x[1m])[1h:5m])"), 'max_over_time(rate(x{cluster="stg"}[1m])[1h:5m])');
  assert.equal(P("ns:requests:rate5m"), 'ns:requests:rate5m{cluster="stg"}');
});

test("PromQL: strings are never touched, and an existing cluster matcher is kept", () => {
  assert.equal(
    P('label_replace(up, "dst", "$1", "src", "(.*){2}")'),
    'label_replace(up{cluster="stg"}, "dst", "$1", "src", "(.*){2}")'
  );
  assert.equal(P('up{pod=~"a{2}"}'), 'up{cluster="stg", pod=~"a{2}"}');
  assert.equal(P('up{cluster="dev"}'), 'up{cluster="dev"}');
  assert.equal(P('up{job="x", cluster=~"dev|stg"}'), 'up{job="x", cluster=~"dev|stg"}');
  assert.equal(P('up{job="cluster=x"}'), 'up{cluster="stg", job="cluster=x"}');
  assert.equal(P("time() - 5"), "time() - 5");
});

test("LogQL: stream selectors only; pipelines and templates untouched", () => {
  assert.equal(L('{app="nginx"} |= "error"'), '{cluster="stg", app="nginx"} |= "error"');
  assert.equal(
    L('sum by (level) (count_over_time({namespace="default"} | json | level="error" [5m]))'),
    'sum by (level) (count_over_time({cluster="stg", namespace="default"} | json | level="error" [5m]))'
  );
  assert.equal(L('{app="x"} | line_format "{{.msg}}" | label_format a=`{{.b}}`'), '{cluster="stg", app="x"} | line_format "{{.msg}}" | label_format a=`{{.b}}`');
  assert.equal(L('{cluster="stg", app="x"}'), '{cluster="stg", app="x"}');
});

test("which tools carry a query", () => {
  assert.equal(queryLanguage("prometheus_query_range"), "promql");
  assert.equal(queryLanguage("loki_get_streams"), "logql");
  assert.equal(queryLanguage("prometheus_get_rules"), null);
  assert.equal(queryLanguage("loki_get_label_values"), null);
});
