// Part of STYLES (../styles.ts): the dark scheme's token values. DECLARATIONS ONLY — no selector
// and no braces, because styles.ts sets this block down twice: once for a reader whose system
// asks for dark (and who has not chosen light), once for a reader who chose dark whatever the
// system says. Two selectors cannot share one block across a media query, and a chunk may not
// interpolate, so the block is a string and the two wrappers live in styles.ts. A template
// literal — read the rules in styles.ts first.
export const DARK_TOKENS_CSS = `
  --bg: #0c0e1a; --surface: #151829; --surface-2: #1f2440;
  /* Lighter than --surface here, not equal to it: on a dark page a raised element gains light
     rather than shadow, and a shadow under a dark card on a darker page is invisible. */
  --surface-raised: #1a1e33;
  --border: #272c47; --border-strong: #3b4268;
  --text: #e9ebf7; --text-dim: #a0a6c2;

  /* The ramp inverts: on a dark surface the LIGHTEST step is the one that carries text, so
     600 is the brightest here and 400 the dimmest. Same names, same jobs, so every rule that
     reads --brand-600 for text and --brand-400 for decoration stays correct in both schemes
     without knowing which one it is in. */
  --brand-600: #9a94ff; --brand-500: #7f78ea; --brand-400: #4a43a8;
  --accent: var(--brand-600); --on-accent: #100d30;
  --brand-tint: #221f4d;

  /* The rail stays ink and goes a step under the page, so it is still the darkest thing on
     the screen. Its text ramp does not move: what reads on #14172a reads on this. */
  --rail: #080a13; --rail-active: #1c2036; --rail-line: #1f2339;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .30), 0 1px 3px rgba(0, 0, 0, .24);
  --shadow-md: 0 6px 18px rgba(0, 0, 0, .38), 0 2px 6px rgba(0, 0, 0, .26);

  --critical: #ff8a80; --warning: #f0b860; --info: #86b7f5; --ok: #6fd39b;
  --tint-critical: #3a1614; --tint-warning: #33250c; --tint-info: #132a45; --tint-ok: #10301f;
  /* Identical to the text ramp here, and that is the finding rather than an oversight: on a
     dark surface the colour that reads as type (7.2-9.2:1) is already the colour that reads
     as its own name. It is only on white that a readable amber has to be darkened into a
     brown. The names still exist in both schemes so no rule has to know which one it is in. */
  --mark-critical: var(--critical); --mark-warning: var(--warning);
  --mark-info: var(--info); --mark-ok: var(--ok);
  /* 4.45:1 on --surface-raised, 4.76 on --surface — the map's two backgrounds. */
  --mark-line: #7b8695;
`;
