// /topology's tool families as dialogs (2026-11-19). The server renders one closed <dialog> per
// family (topology-list.ts toolDialog) and every family tile as a plain link to ?family=, which the
// page renders in place — so without this script nothing is lost but the pop-up. With it, a tile
// (data-dialog) and a family card on the map (href="#cap-<i>") open the dialog with showModal(): Esc,
// the backdrop, focus kept inside and the page behind made inert are the browser's own behaviour.
// This file adds what the element does not: group tabs down the left, the filter, a click on the
// backdrop to close, and focus handed back to whatever opened it.

/** The map links to families as #cap-<i>; such a hash on arrival opens that family's dialog. */
export const DIALOG_HASH = /^#(cap-\d+)$/;

/** A tool card matches when the filter is empty or its searchable text contains it. */
export function toolMatches(search: string, q: string): boolean {
  const t = q.trim().toLowerCase();
  return !t || search.toLowerCase().includes(t);
}

/** Roving focus over a vertical tab list: arrows wrap, Home/End jump; other keys are not ours. */
export function nextTab(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function wireDialog(d: HTMLDialogElement, onClose: () => void): void {
  const tabs = Array.from(d.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = Array.from(d.querySelectorAll<HTMLElement>("[data-panel]"));
  const cards = Array.from(d.querySelectorAll<HTMLElement>(".topo-tool-card"));
  const input = d.querySelector<HTMLInputElement>("input[data-filter]");
  const none = d.querySelector<HTMLElement>(".topo-filter-none");
  let current = 0;

  const select = (j: number, focus = false): void => {
    current = j;
    tabs.forEach((t, k) => {
      t.setAttribute("aria-selected", String(k === j));
      t.tabIndex = k === j ? 0 : -1;
    });
    panels.forEach((p, k) => (p.hidden = k !== j));
    if (focus) tabs[j]?.focus();
  };

  // While filtering, every group's matches show at once and the tabs step back: a match in another
  // group must not hide behind a tab the reader did not pick.
  const applyFilter = (): void => {
    const q = input?.value ?? "";
    if (!q.trim()) {
      cards.forEach((c) => (c.hidden = false));
      d.classList.remove("is-filtering");
      if (none) none.hidden = true;
      select(current);
      return;
    }
    d.classList.add("is-filtering");
    let any = false;
    for (const c of cards) {
      const ok = toolMatches(c.dataset.search ?? "", q);
      c.hidden = !ok;
      any ||= ok;
    }
    for (const p of panels) p.hidden = !p.querySelector(".topo-tool-card:not([hidden])");
    if (none) none.hidden = any;
  };
  const clearFilter = (): void => {
    if (input && input.value) {
      input.value = "";
      applyFilter();
    }
  };

  tabs.forEach((t, j) => {
    t.addEventListener("click", () => {
      clearFilter();
      select(j);
    });
    t.addEventListener("keydown", (e) => {
      const n = nextTab(j, e.key, tabs.length);
      if (n === null) return;
      e.preventDefault();
      clearFilter();
      select(n, true);
    });
  });
  input?.addEventListener("input", applyFilter);
  // A click that lands on the <dialog> itself, not on anything inside it, is a click on the backdrop:
  // the content fills the dialog's box, so only the area outside it targets the element.
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  d.addEventListener("close", () => {
    clearFilter();
    select(0);
    onClose();
  });
}

export function wireToolDialogs(doc: Document = document): void {
  const win = doc.defaultView;
  if (!win || typeof win.HTMLDialogElement === "undefined") return;
  const dialogs = Array.from(doc.querySelectorAll<HTMLDialogElement>("dialog.topo-dialog"));
  if (dialogs.length === 0) return;
  let opener: HTMLElement | null = null;

  const open = (id: string, from: HTMLElement | null): boolean => {
    const d = doc.getElementById(id);
    if (!(d instanceof win.HTMLDialogElement)) return false;
    opener = from;
    if (!d.open) d.showModal();
    return true;
  };

  // Delegated, and last in line: the map's own handlers (a drag that ends on a card) run first and
  // may cancel the click, which is respected. A modified click keeps the link's own meaning.
  doc.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[data-dialog], a[href^='#cap-']");
    if (!a) return;
    const id = a.dataset.dialog ?? (a.getAttribute("href") ?? "").slice(1);
    if (open(id, a)) e.preventDefault();
  });

  // A link from elsewhere (or a map click the handler above missed) arrives as #cap-<i>.
  const fromHash = (): void => {
    const m = DIALOG_HASH.exec(doc.location.hash);
    if (m && open(m[1]!, null)) win.history.replaceState(null, "", doc.location.pathname + doc.location.search);
  };
  fromHash();
  win.addEventListener("hashchange", fromHash);

  for (const d of dialogs) {
    wireDialog(d, () => {
      opener?.focus();
      opener = null;
    });
  }
}
