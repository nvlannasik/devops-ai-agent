// Every node card is an <a> to its own row in the tables below — "the map is the glance, the
// row is the record", which is the trip this page has always offered and the one thing the
// old script-free SVG got for free. Making the cards draggable put that in conflict: a browser
// fires `click` on an anchor at the end of a drag that started on it, so dragging a card to
// see behind it navigated away from the map instead.
//
// React Flow's own nodeDragThreshold does not help — it decides whether a DRAG happened, not
// whether the click that follows should be suppressed. So the drag's end time is recorded here
// and the anchor checks it. A module-level value rather than context or a ref: both sides are
// in the same bundle, there is exactly one map on the page, and threading a ref through
// serialized node data is not possible anyway.
let lastDragEnd = 0;

export const markDragEnd = (): void => {
  lastDragEnd = Date.now();
};

// 200ms is long enough to cover the click a pointer-up synthesises and short enough that a
// deliberate second click — a reader who drags a card and then decides to follow it — is not
// swallowed. Measured against a trackpad, where the gap is the slowest.
export const justDragged = (): boolean => Date.now() - lastDragEnd < 200;
