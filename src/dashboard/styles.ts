// One stylesheet, inlined into every page. No build step and no CDN, so everything the
// page needs must be in the document. Components read only from the tokens at the top —
// never hard-code a colour below :root.
export const STYLES = `
:root {
  --fs-xs: .75rem; --fs-sm: .875rem; --fs-base: 1rem;
  --fs-lg: 1.25rem; --fs-xl: 1.75rem; --fs-metric: 2.5rem;
  --sp-1: .25rem; --sp-2: .5rem; --sp-3: .75rem;
  --sp-4: 1rem; --sp-6: 1.5rem; --sp-8: 2rem;
  --radius: 8px; --maxw: 1200px;

  --bg: #fbfbfd; --surface: #fff; --surface-2: #f4f4f7;
  --border: #e4e4e9; --text: #1a1a1f; --text-dim: #6b6b76;
  --accent: #3b5bdb;
  --critical: #d63939; --warning: #d99400; --info: #3b7cd6; --ok: #2f9e63;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121216; --surface: #1a1a20; --surface-2: #22222a;
    --border: #2a2a33; --text: #e8e8ed; --text-dim: #9a9aa5;
    --accent: #7c93f5;
    --critical: #f06565; --warning: #e8b04b; --info: #6ba6f5; --ok: #4fc384;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font); font-size: var(--fs-sm); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

header.top {
  position: sticky; top: 0; z-index: 10;
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: var(--sp-3) var(--sp-6);
  display: flex; align-items: baseline; gap: var(--sp-6);
}
header.top .brand { font-weight: 650; font-size: var(--fs-base); letter-spacing: -.01em; }
header.top nav { display: flex; gap: var(--sp-4); }
header.top nav a { color: var(--text-dim); font-weight: 500; }
header.top nav a:hover, header.top nav a[aria-current] { color: var(--text); text-decoration: none; }

main { max-width: var(--maxw); margin: 0 auto; padding: var(--sp-8) var(--sp-6); }
h1 { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -.02em; margin: 0 0 var(--sp-6); }
h2 { font-size: var(--fs-lg); font-weight: 600; margin: var(--sp-8) 0 var(--sp-4); }

.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--sp-4); }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4) var(--sp-4) var(--sp-3); }
.metric .label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); }
.metric .value { font-size: var(--fs-metric); font-weight: 620; letter-spacing: -.03em; line-height: 1.1; margin-top: var(--sp-2); font-variant-numeric: tabular-nums; }
.metric .sub { font-size: var(--fs-xs); color: var(--text-dim); }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4); }

table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
th { text-align: left; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); font-weight: 600; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); }
td { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }
td.num { font-variant-numeric: tabular-nums; }
td.when { color: var(--text-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }

.pill { display: inline-block; font-size: var(--fs-xs); font-weight: 600; padding: 2px var(--sp-2); border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.pill.critical { color: var(--critical); }
.pill.warning  { color: var(--warning); }
.pill.info     { color: var(--info); }
.pill.ok, .pill.succeeded, .pill.resolved { color: var(--ok); }
.pill.failed, .pill.rejected { color: var(--critical); }
.pill.proposed, .pill.approved, .pill.executing { color: var(--text-dim); }

form.filters { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: end; margin-bottom: var(--sp-4); }
form.filters label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-dim); }
form.filters input, form.filters select {
  font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: var(--sp-2) var(--sp-3); min-width: 150px;
}
form.filters button {
  font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
  background: var(--accent); color: #fff; border: 0;
  border-radius: 6px; padding: var(--sp-2) var(--sp-4);
}
form.filters button:hover { filter: brightness(1.08); }

.rca { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--sp-4); white-space: pre-wrap; word-break: break-word; font-size: var(--fs-sm); line-height: 1.65; }
code, .mono { font-family: var(--mono); font-size: .92em; }

.empty { text-align: center; color: var(--text-dim); padding: var(--sp-8); border: 1px dashed var(--border); border-radius: var(--radius); }
.pager { display: flex; gap: var(--sp-3); margin-top: var(--sp-4); }
.meta { color: var(--text-dim); font-size: var(--fs-xs); }

.chart { width: 100%; height: auto; display: block; }
.chart-bar { fill: var(--accent); }
.chart-bar:hover { filter: brightness(1.15); }
.chart-label, .chart-empty { fill: var(--text-dim); font-size: 10px; font-family: var(--font); }
`;
