// Build-time constants injected by Vite's `define` (see vite.config.ts).
// `__DOCO_VERSION__` is the monorepo root package.json version; the alpha
// has no tags so the version pill in the header reads from this single
// source. `__DOCO_RELEASE_AT__` is the ISO timestamp of the latest git
// commit at build time — used to render "released N minutes/hours/days
// ago" beside the version.
declare const __DOCO_VERSION__: string;
declare const __DOCO_RELEASE_AT__: string;
