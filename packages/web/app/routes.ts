import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Doco web routes. Hosted-multi-tenant only (per ADR-092 + ADR-093):
 *
 *   /                              host home (anonymous landing or signed-in dashboard)
 *   /sign-in, /sign-out, /sign-up  auth (cookie locally; OAuth in prod per ADR-066, ADR-094)
 *   /onboarding/*                  first-run wizard (ADR-073)
 *   /claim/:token                  agent-created Doco claim flow
 *   /agents, /agents/new           agent self-service (ADR-071)
 *   /invite, /invite/:token        legacy invitation flow (superseded by /agents/new, ADR-068..071)
 *   /new-doco, /new-org            self-service create flows (ADR-067)
 *   /:owner                        owner profile + Docos
 *   /:owner/:doco                  per-Doco recent
 *   /:owner/:doco/e/:type          per-Doco entity list
 *   /:owner/:doco/e/:type/:id      per-Doco entity detail
 *   /:owner/:doco/search           per-Doco search
 *   /:owner/:doco/lint             per-Doco lint
 *   /:owner/:doco/coverage         per-Doco drift (ADR-090)
 *   /:owner/:doco/scopes/new       per-Doco scope-add (ADR-080)
 *   /api/suggest-scopes            LLM scope suggestions (ADR-085)
 */
export default [
  index("routes/_index.tsx"),
  // Auth
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("sign-up", "routes/sign-up.tsx"),
  // Self-service create
  route("new-doco", "routes/new-doco.tsx"),
  route("new-org", "routes/new-org.tsx"),
  // Onboarding
  route("onboarding/join", "routes/onboarding.join._index.tsx"),
  route("onboarding/join/human", "routes/onboarding.join.human.tsx"),
  route("onboarding/join/agent", "routes/onboarding.join.agent.tsx"),
  route("onboarding/create", "routes/onboarding.create._index.tsx"),
  route("onboarding/create/human", "routes/onboarding.create.human.tsx"),
  route("onboarding/create/agent", "routes/onboarding.create.agent.tsx"),
  route("claim/:token", "routes/claim.$token.tsx"),
  // Agents
  route("agents", "routes/agents._index.tsx"),
  route("agents/new", "routes/agents.new.tsx"),
  // Legacy invitations (superseded by /agents/new)
  route("invite", "routes/invite.tsx"),
  route("invite/:token", "routes/invite.$token.tsx"),
  route("invite/:token.json", "routes/invite.$token[.]json.tsx"),
  // API
  route("api/suggest-scopes", "routes/api.suggest-scopes.tsx"),
  // Owner + per-Doco
  route(":ownerSlug", "routes/$ownerSlug._index.tsx"),
  route(":ownerSlug/:docoSlug", "routes/$ownerSlug.$docoSlug._index.tsx"),
  route(":ownerSlug/:docoSlug/e/:type", "routes/$ownerSlug.$docoSlug.e.$type._index.tsx"),
  route(":ownerSlug/:docoSlug/e/:type/:id", "routes/$ownerSlug.$docoSlug.e.$type.$id.tsx"),
  route(":ownerSlug/:docoSlug/search", "routes/$ownerSlug.$docoSlug.search.tsx"),
  route(":ownerSlug/:docoSlug/lint", "routes/$ownerSlug.$docoSlug.lint.tsx"),
  route(":ownerSlug/:docoSlug/coverage", "routes/$ownerSlug.$docoSlug.coverage.tsx"),
  route(":ownerSlug/:docoSlug/scopes/new", "routes/$ownerSlug.$docoSlug.scopes.new.tsx"),
] satisfies RouteConfig;
