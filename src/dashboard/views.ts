// The dashboard's pages, one module per page (2026-10-21 split). This file is only the barrel that
// server.ts and the tests import from; a page module imports ./parts.js and ./layout.js, never this.
export * from "./parts.js";
export * from "./layout.js";
export * from "./overview-views.js";
export * from "./incident-views.js";
export * from "./harness-views.js";
export * from "./agent-views.js";
export * from "./bench-views.js";
export * from "./cluster-views.js";
export * from "./people-views.js";
