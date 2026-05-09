import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("e/:type", "routes/e.$type._index.tsx"),
  route("e/:type/:id", "routes/e.$type.$id.tsx"),
  route("search", "routes/search.tsx"),
  route("lint", "routes/lint.tsx"),
  // Auth (host-mode only; ADR-066)
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  // Host-mode per-Evalo routes (Phase 7). URL: /:owner/:evalo/...
  route(":ownerSlug/:evaloSlug", "routes/$ownerSlug.$evaloSlug._index.tsx"),
  route(
    ":ownerSlug/:evaloSlug/e/:type/:id",
    "routes/$ownerSlug.$evaloSlug.e.$type.$id.tsx",
  ),
] satisfies RouteConfig;
