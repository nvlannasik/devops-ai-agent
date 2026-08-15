// The interactive layer for the dependency map: drag to pan, ctrl/cmd + wheel or the toolbar
// to zoom. Shipped as one inline <script> carrying a per-response nonce (see csp() in
// server.ts) — never 'unsafe-inline'. Elsewhere this dashboard renders LLM output and
// Alertmanager labels, and a session in front of the port is not a defence against a stored
// XSS in an RCA: the nonce keeps "a missed esc() is inert" true for every other page.
//
// Progressive enhancement, not a replacement. The page still ships the script-free control it
// always had — three radios whose :checked state sets the SVG's width — and this file takes
// over from it: it removes those radios, flips the frame to data-live, and drives the viewBox
// instead. With scripting off, or this script blocked, the page is exactly what it was before:
// the map renders, scales in three steps, and every box still links to its row. Nothing here
// is the only way to read the diagram.
//
// viewBox, not a CSS transform: the <svg> keeps its own box and its intrinsic aspect ratio, so
// a pointer position converts to user units by one ratio with no letterboxing to correct for,
// the drawing stays vector-sharp at every scale, and pan needs no scroll container to fake it.
//
// Same guard as styles.ts: NO backticks and NO dollar-brace inside this template literal.
export const TOPO_SCRIPT = `
(() => {
  const frame = document.querySelector(".topo-frame");
  const svg = frame && frame.querySelector("svg.topo");
  const view = frame && frame.querySelector(".topo-view");
  const tools = frame && frame.querySelector(".topo-tools");
  const level = frame && frame.querySelector(".topo-level");
  const zin = tools && tools.querySelector("[data-zoom=in]");
  const zout = tools && tools.querySelector("[data-zoom=out]");
  // Bails silently and leaves the radios in place. Anything missing here means the markup and
  // this file have drifted, and a half-wired map is worse than the one that already worked.
  if (!frame || !svg || !view || !tools || !level || !zin || !zout || !svg.viewBox.baseVal.width) return;

  const W = svg.viewBox.baseVal.width;
  const H = svg.viewBox.baseVal.height;
  const MIN = 1, MAX = 8, STEP = 1.5;
  let x = 0, y = 0, k = 1;
  let drag = null, dragged = false;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // The only writer of the viewBox, so no path — drag, wheel, key, focus — can leave the
  // window off the edge of the drawing and strand a reader on empty canvas.
  const apply = () => {
    const w = W / k, h = H / k;
    x = clamp(x, 0, W - w);
    y = clamp(y, 0, H - h);
    svg.setAttribute("viewBox", x + " " + y + " " + w + " " + h);
    level.textContent = Math.round(k * 100) + "%";
    // aria-disabled, not disabled: a disabled button drops focus the moment the keyboard
    // reaches the limit, and the next Tab restarts from the top of the document.
    zout.setAttribute("aria-disabled", k <= MIN);
    zin.setAttribute("aria-disabled", k >= MAX);
  };

  // Zoom about a point given as a fraction of the viewport, so whatever is under the cursor
  // stays under the cursor. The buttons and the keyboard pass the centre.
  const zoomTo = (next, fx, fy) => {
    const k2 = clamp(next, MIN, MAX);
    if (k2 === k) return;
    const px = x + fx * (W / k), py = y + fy * (H / k);
    k = k2;
    x = px - fx * (W / k);
    y = py - fy * (H / k);
    apply();
  };

  const reset = () => { k = 1; x = 0; y = 0; apply(); };

  const at = (e) => {
    const r = svg.getBoundingClientRect();
    return { fx: clamp((e.clientX - r.left) / r.width, 0, 1), fy: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };

  // Pan. Capture is taken on the first real movement, not on pointerdown: capturing early
  // retargets the click that follows, and every box in this map is a link to its own row.
  view.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragged = false;
    drag = { id: e.pointerId, cx: e.clientX, cy: e.clientY, x: x, y: y, on: false };
  });

  view.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.cx, dy = e.clientY - drag.cy;
    // 4px of slack, so a hand that moves while clicking a box still follows its link.
    if (!drag.on) {
      if (dx * dx + dy * dy < 16) return;
      drag.on = true;
      // Capture only keeps the events coming once the pointer leaves the box; without it the
      // drag ends at the edge instead of failing. Not worth taking the pan down with it.
      try { view.setPointerCapture(e.pointerId); } catch (err) { /* pan works either way */ }
      frame.setAttribute("data-drag", "on");
    }
    const r = svg.getBoundingClientRect();
    x = drag.x - dx * (W / k) / r.width;
    y = drag.y - dy * (H / k) / r.height;
    apply();
    e.preventDefault();
  });

  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    dragged = drag.on;
    frame.removeAttribute("data-drag");
    drag = null;
  };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);

  // A drag that happens to end on top of a box must not also open that box's row. The flag is
  // cleared by the click it swallows or by the next pointerdown, so a drag that ends where no
  // click follows cannot eat a later, real one.
  view.addEventListener("click", (e) => {
    if (!dragged) return;
    dragged = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Ctrl/cmd only — the modifier a trackpad pinch already sends. A bare wheel keeps scrolling
  // the page: this map sits in the middle of a long document, and a figure that swallowed the
  // scroll wheel would trap the reader every time the pointer crossed it.
  view.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const p = at(e);
    zoomTo(k * Math.exp(-e.deltaY * 0.0025), p.fx, p.fy);
  }, { passive: false });

  tools.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-zoom]");
    if (!b) return;
    const a = b.getAttribute("data-zoom");
    if (a === "reset") reset();
    else zoomTo(a === "in" ? k * STEP : k / STEP, 0.5, 0.5);
  });

  view.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sx = (W / k) * 0.15, sy = (H / k) * 0.15;
    const key = e.key;
    if (key === "ArrowLeft") x -= sx;
    else if (key === "ArrowRight") x += sx;
    else if (key === "ArrowUp") y -= sy;
    else if (key === "ArrowDown") y += sy;
    else if (key === "+" || key === "=") zoomTo(k * STEP, 0.5, 0.5);
    else if (key === "-" || key === "_") zoomTo(k / STEP, 0.5, 0.5);
    else if (key === "0") reset();
    else return;
    // The zoom branches have applied already; apply() is idempotent, which is what lets the
    // pan branches fall through to it instead of each repeating the call.
    apply();
    e.preventDefault();
  });

  // Tabbing through the boxes has to keep working when zoomed in. Nothing else can bring a
  // focused box back: the viewBox clips it, so there is no scroll for the browser to do.
  svg.addEventListener("focusin", (e) => {
    if (!e.target.getBBox) return;
    const b = e.target.getBBox(), w = W / k, h = H / k, m = 12;
    if (b.x < x + m) x = b.x - m;
    else if (b.x + b.width > x + w - m) x = b.x + b.width - w + m;
    if (b.y < y + m) y = b.y - m;
    else if (b.y + b.height > y + h - m) y = b.y + b.height - h + m;
    apply();
  });

  // Last, on purpose: the script-free controls only come out once every listener above is
  // wired, so a throw on any line leaves the page with a zoom control that still works.
  frame.querySelectorAll(".topo-z, .topo-bar").forEach((el) => el.remove());
  view.tabIndex = 0;
  view.setAttribute("aria-label", "Dependency map viewport. Drag to pan, arrow keys to move, plus and minus to zoom.");
  frame.setAttribute("data-live", "on");
  apply();
})();
`;
