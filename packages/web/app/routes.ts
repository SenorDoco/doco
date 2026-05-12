import { type RouteConfig, index, route } from "@react-router/dev/routes";

// Local-solo Doco workspace routes (ADR-087).
// Single Doco at root: URLs are `/` for recent, `/e/...` for entities.
// Hosted-multi-tenant (owner-prefixed URLs, sign-in, onboarding, agent
// invitations, claim) was removed; rebuild from this base if hosted demand
// materializes.
export default [
  index("routes/_index.tsx"),
  route("e/:type", "routes/e.$type._index.tsx"),
  route("e/:type/:id", "routes/e.$type.$id.tsx"),
  route("search", "routes/search.tsx"),
  route("lint", "routes/lint.tsx"),
  route("api/recent", "routes/api.recent.tsx"),
] satisfies RouteConfig;
