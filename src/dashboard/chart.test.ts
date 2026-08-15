import { test } from "node:test";
import assert from "node:assert/strict";
import { barChart } from "./chart.js";

const series = [
  { label: "05-19", value: 14 },
  { label: "05-26", value: 9 },
  { label: "06-02", value: 22 },
];

test("one column per point, and the count is published for the grid", () => {
  const html = barChart(series);
  assert.equal(html.match(/class="chart-col"/g)?.length, 3);
  assert.match(html, /--n:3/, "the column count drives both the plot and the axis grid");
  assert.equal(html.match(/class="chart-tick"/g)?.length, 3, "one tick per column");
});

test("heights are percentages of the tallest bar, never a fixed pixel size", () => {
  const html = barChart(series);
  assert.match(html, /--h:100%/, "the tallest point sets the scale");
  // 14/22 = 63.6%, one decimal place
  assert.match(html, /--h:63\.6%/);
  assert.doesNotMatch(html, /px/, "nothing here is measured in pixels — that is CSS's job");
});

test("the newest column is marked, and it is the last one", () => {
  const html = barChart(series);
  const cols = html.split(`<div class="chart-col"`).slice(1);
  assert.equal(cols.length, 3);
  assert.deepEqual(
    cols.map((c) => c.includes("data-current")),
    [false, false, true],
    "the mark belongs to the last column and only to it"
  );
  assert.match(html, /period in progress/, "and the caption says what the mark means");
});

test("thinnable ticks are counted from the end, so the newest label always survives", () => {
  const html = barChart([
    { label: "a", value: 1 },
    { label: "b", value: 2 },
    { label: "c", value: 3 },
    { label: "d", value: 4 },
  ]);
  const ticks = [...html.matchAll(/<span class="chart-tick"( data-thin)?>([a-d])<\/span>/g)].map(
    (m) => [m[2]!, Boolean(m[1])] as [string, boolean]
  );
  // Alternating, counted backwards from the newest — so on an even count the FIRST label is the
  // droppable one. Counting forwards would drop the last, which is the week in progress and the
  // column a reader looks at first.
  assert.deepEqual(ticks, [
    ["a", true],
    ["b", false],
    ["c", true],
    ["d", false],
  ]);
});

test("an empty series renders a labelled blank, with no NaN or Infinity anywhere", () => {
  const html = barChart([], { label: "incidents per week" });
  assert.match(html, /no data yet/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(html, /chart-plot/, "the blank keeps the plot's height so nothing reflows later");
});

test("a single point and an all-zero series both survive the scale", () => {
  const one = barChart([{ label: "06-02", value: 5 }]);
  assert.match(one, /--h:100%/);
  assert.doesNotMatch(one, /NaN|Infinity/);

  const zeros = barChart([
    { label: "a", value: 0 },
    { label: "b", value: 0 },
  ]);
  assert.doesNotMatch(zeros, /NaN|Infinity/, "max || 1 keeps the division defined");
  assert.equal(zeros.match(/data-zero/g)?.length, 2, "a week with no incidents draws no bar");
});

test("labels and values are escaped — both reach here from the database", () => {
  const html = barChart([{ label: `<script>alert(1)</script>`, value: 3 }]);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("a string value from Postgres int8 is escaped and still measured", () => {
  // node-postgres hands int8 back as a string, so the value that reaches the style attribute
  // is re-derived with Number() rather than trusted.
  const html = barChart([
    { label: "a", value: "12" as unknown as number },
    { label: "b", value: `"><script>alert(1)</script>` as unknown as number },
  ]);
  assert.doesNotMatch(html, /<script>/, "a hostile value cannot break out of the attribute");
  assert.doesNotMatch(html, /--h:NaN/, "and it cannot put NaN in a style attribute either");
  assert.match(html, /--h:100%/, "the numeric one still sets the scale");
});
