import type { IconName } from "../topology-types.js";

// Hand-written inline SVG, like the rest of this dashboard's glyphs — `default-src 'none'`
// blocks icon fonts and sprite <use> both, so there is no third option. Every one is
// stroke-only on currentColor with no fill and no colour of its own: colour on this map is
// spent on the SQS hop and on not-configured, and a glyph that carried a third would make
// both ambiguous.
//
// Keyed by IconName, which is a closed union — so `buildTopology` naming an icon the client
// does not have is a type error rather than a blank square.
const PATHS: Record<IconName, string> = {
  // speech bubble — Slack
  chat: "M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-2.8-.4L3 21l1.6-4.7A8.2 8.2 0 0 1 3 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 9 8.4Z",
  // bell — the Alertmanager webhook
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  // stacked discs — Postgres. The one glyph a reader will look for by shape alone.
  db: "M12 5c4.4 0 8-1.1 8-2.5S16.4 0 12 0 4 1.1 4 2.5 7.6 5 12 5ZM4 2.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6M4 8.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6M4 14.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6",
  // lightning in a box — Redis, a cache: the same store shape, but fast and expiring
  cache: "M3 5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5ZM13 7l-4 6h3l-1 4 4-6h-3Z",
  // stacked slips — an SQS queue
  queue: "M3 7h18M3 12h18M3 17h18M6 4v16",
  // plug — the MCP server
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0ZM12 17v5",
  // chip — an LLM backend
  chip: "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M6 5h12v14H6Z",
};

/**
 * `aria-hidden` on every one, without exception: the card's title says what it is, and a glyph
 * that also announced itself would have a screen reader read the same node twice.
 */
export function Icon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <svg
      className="topo-node-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
