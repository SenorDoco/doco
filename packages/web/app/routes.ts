import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("e/:type", "routes/e.$type._index.tsx"),
  route("e/:type/:id", "routes/e.$type.$id.tsx"),
  route("search", "routes/search.tsx"),
  route("lint", "routes/lint.tsx"),
  route("coverage", "routes/coverage.tsx"),
  route("api/recent", "routes/api.recent.tsx"),
  // Auth (host-mode only; ADR-066, ADR-067)
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("sign-up", "routes/sign-up.tsx"),
  // Host-mode self-service flows (ADR-067)
  route("new-doco", "routes/new-doco.tsx"),
  route("new-org", "routes/new-org.tsx"),
  // Onboarding wizard (ADR-073)
  route("onboarding/join", "routes/onboarding.join._index.tsx"),
  route("onboarding/join/human", "routes/onboarding.join.human.tsx"),
  route("onboarding/join/agent", "routes/onboarding.join.agent.tsx"),
  route("onboarding/create", "routes/onboarding.create._index.tsx"),
  route("onboarding/create/human", "routes/onboarding.create.human.tsx"),
  route("onboarding/create/agent", "routes/onboarding.create.agent.tsx"),
  route("claim/:token", "routes/claim.$token.tsx"),
  // Agent self-service provisioning (ADR-071) — primary path now.
  route("agents", "routes/agents._index.tsx"),
  route("agents/new", "routes/agents.new.tsx"),
  // Agent invitation flow (ADR-037, ADR-068, ADR-069) — superseded by /agents/new
  // per ADR-071, kept for backward compat.
  route("invite", "routes/invite.tsx"),
  route("invite/:token", "routes/invite.$token.tsx"),
  // Resource route returning the same manifest as JSON. Stable .json URL.
  route("invite/:token.json", "routes/invite.$token[.]json.tsx"),
  // Host-mode owner profile + per-Doco routes (Phase 7 / ADR-067)
  route(":ownerSlug", "routes/$ownerSlug._index.tsx"),
  route(":ownerSlug/:docoSlug", "routes/$ownerSlug.$docoSlug._index.tsx"),
  route(":ownerSlug/:docoSlug/e/:type", "routes/$ownerSlug.$docoSlug.e.$type._index.tsx"),
  route(
    ":ownerSlug/:docoSlug/e/:type/:id",
    "routes/$ownerSlug.$docoSlug.e.$type.$id.tsx",
  ),
  route(":ownerSlug/:docoSlug/search", "routes/$ownerSlug.$docoSlug.search.tsx"),
  // ADR-082 follow-up: LLM-based scope suggestions for /scopes/new.
  route("api/suggest-scopes", "routes/api.suggest-scopes.tsx"),
  route(":ownerSlug/:docoSlug/lint", "routes/$ownerSlug.$docoSlug.lint.tsx"),
  route(":ownerSlug/:docoSlug/coverage", "routes/$ownerSlug.$docoSlug.coverage.tsx"),
  // ADR-080 (rev 2): scope setup as the second step after Doco creation.
  route(
    ":ownerSlug/:docoSlug/scopes/new",
    "routes/$ownerSlug.$docoSlug.scopes.new.tsx",
  ),
] satisfies RouteConfig;
