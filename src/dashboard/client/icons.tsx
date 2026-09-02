import { Bell, Cpu, Database, DatabaseZap, Layers, MessageSquare, Plug } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { IconName } from "../topology-types.js";

// lucide-react — the icon set shadcn/ui itself uses, which is what makes this the answer to
// "can we use shadcn for the icons": shadcn is a component collection on Radix + Tailwind and
// ships no icons of its own. Taking lucide alone gets the drawing without bringing a second
// styling system alongside `styles.ts`, which is 2000+ lines of hand-computed contrast ratios,
// container queries and a documented colour discipline.
//
// It replaced seven hand-written paths. Not because those were wrong, but because they were
// drawn by hand on an unfamiliar grid: lucide's are on a consistent 24×24 with matched optical
// weight and terminals, which is exactly the difference that shows at 14px in a row of cards.
//
// Tree-shaken by esbuild — only the icons named here reach the bundle. Import them BY NAME from
// the package root; a deep import into `lucide-react/dist/...` would pin an internal path.
//
// Every constraint the hand-drawn set had still holds and lucide satisfies all of them: it
// renders inline <svg> (no icon font, no sprite <use> — `default-src 'none'` blocks both),
// strokes `currentColor` with no fill, and takes the size and stroke width as props.
const ICONS: Record<IconName, LucideIcon> = {
  chat: MessageSquare,
  bell: Bell,
  db: Database,
  // A cache is a database that forgets. DatabaseZap says both in one glyph, which is better
  // than the lightning-in-a-box the hand-drawn set used and read as "power".
  cache: DatabaseZap,
  queue: Layers,
  plug: Plug,
  chip: Cpu,
};

/**
 * `aria-hidden` on every one, without exception: the card's title already says what it is, and
 * a glyph that also announced itself would have a screen reader read the same node twice.
 *
 * Size and stroke are stated here rather than left to lucide's defaults (24px / 2) because the
 * CSS sizes the box and the two would disagree: a 24px viewBox drawn into a 14px box at stroke
 * 2 renders heavier than the 11px type beside it.
 */
export function Icon({ name }: { name: IconName }): React.JSX.Element {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className="topo-node-icon"
      size={14}
      strokeWidth={1.6}
      absoluteStrokeWidth
      aria-hidden="true"
      focusable="false"
    />
  );
}
