import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("e/:type", "routes/e.$type._index.tsx"),
  route("e/:type/:id", "routes/e.$type.$id.tsx"),
  route("search", "routes/search.tsx"),
  route("lint", "routes/lint.tsx"),
  // Auth (host-mode only; ADR-066, ADR-067)
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("sign-up", "routes/sign-up.tsx"),
  // Host-mode self-service flows (ADR-067)
  route("new-evalo", "routes/new-evalo.tsx"),
  route("new-org", "routes/new-org.tsx"),
  // Host-mode owner profile + per-Evalo routes (Phase 7 / ADR-067)
  route(":ownerSlug", "routes/$ownerSlug._index.tsx"),
  route(":ownerSlug/:evaloSlug", "routes/$ownerSlug.$evaloSlug._index.tsx"),
  route(":ownerSlug/:evaloSlug/e/:type", "routes/$ownerSlug.$evaloSlug.e.$type._index.tsx"),
  route(
    ":ownerSlug/:evaloSlug/e/:type/:id",
    "routes/$ownerSlug.$evaloSlug.e.$type.$id.tsx",
  ),
  route(":ownerSlug/:evaloSlug/search", "routes/$ownerSlug.$evaloSlug.search.tsx"),
  route(":ownerSlug/:evaloSlug/lint", "routes/$ownerSlug.$evaloSlug.lint.tsx"),
] satisfies RouteConfig;
