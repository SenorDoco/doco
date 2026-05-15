// Build-time constants injected by Vite's `define` (see vite.config.ts).
// `__DOCO_VERSION__` is the alpha build identity: Vercel git SHA, Vercel
// deployment id, local git SHA, then package.json as the final fallback.
// `__DOCO_RELEASE_AT__` is the ISO timestamp of the latest git commit at
// build time — used to render "released N minutes/hours/days ago" beside
// the version.
declare const __DOCO_VERSION__: string;
declare const __DOCO_RELEASE_AT__: string;
