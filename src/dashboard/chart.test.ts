import { test } from "node:test";
import assert from "node:assert/strict";
import { lineChart } from "./chart.js";
import { STYLES } from "./styles.js";

const series = [
  { label: "05-19", value: 14 },
  { label: "05-26", value: 9 },
  { label: "06-02", value: 22 },
];

test("one column per point, and the count is published for the grid", () => {
  const html = lineChart(series);
  assert.equal(html.match(/class="chart-col"/g)?.length, 3);
  assert.match(html, /--n:3/, "the column count drives both the plot and the axis grid");
  assert.equal(html.match(/class="chart-tick"/g)?.length, 3, "one tick per column");
  assert.equal(html.match(/class="chart-dot"/g)?.length, 3, "and one dot per column");
});

test("heights are percentages of the largest value, never a fixed pixel size", () => {
  const html = lineChart(series);
  assert.match(html, /--h:100%/, "the largest point sets the scale");
  // 14/22 = 63.6%, one decimal place
  assert.match(html, /--h:63\.6%/);
  assert.doesNotMatch(html, /px/, "nothing here is measured in pixels — that is CSS's job");
});

test("the line's vertices are the same heights the dots use, inverted for SVG's y-down axis", () => {
  const html = lineChart(series);
  const pts = html.match(/class="chart-stroke" points="([^"]+)"/)?.[1];
  assert.ok(pts, "no polyline — a line chart with no line");
  // x is the CENTRE of each column so a vertex lands under its own axis label: (i+.5)/3.
  // y is 100 - h, from the same rounded --h the dot reads, so dot and line cannot disagree.
  assert.equal(pts, "16.67,36.4 50,59.1 83.33,0");
});

test("the area is the line closed down to the baseline, and shares its vertices", () => {
  const html = lineChart(series);
  const area = html.match(/class="chart-area" points="([^"]+)"/)?.[1];
  const line = html.match(/class="chart-stroke" points="([^"]+)"/)?.[1];
  assert.ok(area && line);
  assert.equal(area, `16.67,100 ${line} 83.33,100`, "the fill must sit exactly under the stroke");
});

test("the newest column is marked, and it is the last one", () => {
  const html = lineChart(series);
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
  const html = lineChart([
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
  const html = lineChart([], { label: "incidents per week" });
  assert.match(html, /no data yet/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(html, /chart-plot/, "the blank keeps the plot's height so nothing reflows later");
  assert.doesNotMatch(html, /<svg/, "and draws no line, because there is nothing to join");
});

test("a single point is a dot with no line, and an all-zero series survives the scale", () => {
  const one = lineChart([{ label: "06-02", value: 5 }]);
  assert.match(one, /--h:100%/);
  assert.match(one, /class="chart-dot"/, "the point itself still renders");
  assert.doesNotMatch(one, /<svg/, "one vertex is not a line — a polyline of it draws nothing");
  assert.doesNotMatch(one, /NaN|Infinity/);

  const zeros = lineChart([
    { label: "a", value: 0 },
    { label: "b", value: 0 },
  ]);
  assert.doesNotMatch(zeros, /NaN|Infinity/, "max || 1 keeps the division defined");
  // A flat run along the baseline is the truth about a fortnight with no incidents; the line is
  // still drawn, because the absence is the reading.
  assert.match(zeros, /class="chart-stroke" points="25,100 75,100"/);
});

test("labels and values are escaped — both reach here from the database", () => {
  const html = lineChart([{ label: `<script>alert(1)</script>`, value: 3 }]);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("a string value from Postgres int8 is escaped and still measured", () => {
  // node-postgres hands int8 back as a string, so the value that reaches the style attribute
  // is re-derived with Number() rather than trusted.
  const html = lineChart([
    { label: "a", value: "12" as unknown as number },
    { label: "b", value: `"><script>alert(1)</script>` as unknown as number },
  ]);
  assert.doesNotMatch(html, /<script>/, "a hostile value cannot break out of the attribute");
  assert.doesNotMatch(html, /--h:NaN/, "and it cannot put NaN in a style attribute either");
  assert.doesNotMatch(html, /points="[^"]*NaN/, "nor into the path data");
  assert.match(html, /--h:100%/, "the numeric one still sets the scale");
});

test("the plot has no column gap, because a vertex percentage cannot know a px gap", () => {
  // The markup puts each vertex at (i+.5)/n of the PLOT's width. A grid gap is a clamp in px,
  // which moves every track centre by an amount no server-rendered percentage can account for —
  // so the dots would sit off their own line, and worse at the narrow end. The axis below keeps
  // its gap: a label only has to sit under its column, not on a curve.
  const plot = STYLES.match(/^\.chart-plot \{([^}]*)\}/m);
  assert.ok(plot, ".chart-plot has no rule");
  assert.doesNotMatch(plot[1]!, /\bgap:/, "a gap here pushes every dot off the line");
  const axis = STYLES.match(/^\.chart-axis \{([^}]*)\}/m);
  assert.match(axis![1]!, /\bgap:/, "the axis still needs breathing room between labels");
});

test("the drawing takes the plot's box instead of its own square ratio", () => {
  // Both bugs that put the dots off the line, and neither showed up in any markup assertion —
  // they were measured in a headless browser. height:auto handed the sizing back to the unit
  // viewBox, which drew itself SQUARE: 407px of drift at 768. And the dot was centred with a
  // negative margin-top, which an element offset from the bottom edge never uses: a constant
  // 4.5px above the line at every width. Both are 0px now, and this is what holds them there.
  const line = STYLES.match(/^\.chart-line \{([^}]*)\}/ms);
  assert.ok(line, ".chart-line has no rule");
  assert.doesNotMatch(line[1]!, /height: auto/, "auto lets the viewBox's ratio win over the box");
  assert.match(line[1]!, /height: calc\(100% - 1\.15rem\)/, "the plot's box, minus the label band");
  const dot = STYLES.match(/^\.chart-dot \{([^}]*)\}/ms);
  assert.match(dot![1]!, /margin: 0 0 -3\.5px -3\.5px/, "pulled back on the edges it is placed from");
});

test("the stroke does not scale with the non-uniform stretch", () => {
  // preserveAspectRatio="none" stretches a unit square to the plot's box — that is what frees the
  // height from the viewBox's ratio. Without non-scaling-stroke the line comes out as a wedge,
  // thin where the box is wide and thick where it is tall, differently on every screen.
  assert.match(STYLES, /\.chart-stroke \{[^}]*vector-effect: non-scaling-stroke/s);
  assert.match(lineChart(series), /preserveAspectRatio="none"/);
});
