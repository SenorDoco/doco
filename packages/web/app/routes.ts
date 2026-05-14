import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Doco web routes. Hosted-multi-tenant only (per ADR-092 + ADR-093).
 *
 * Routing model: this file is the canonical config (RR v7 config-based
 * routing). File-based routing (`@react-router/fs-routes`) is NOT in
 * use — the explicit manual table doubles as a prose-readable index
 * of the URL surface, grouped by area.
 *
 * Agent-route policy: any route whose path has an `agent` segment MUST also
 * register `<path>.txt` (plain-prose docs for agents) and `<path>.json`
 * (resource route — clean JSON POST endpoint, no document render). Enforced
 * by `pnpm --filter @doco/web lint:routes`. The HTML route must advertise
 * both siblings via `<link rel="alternate">` in its `links()` export so an
 * agent that lands on the browser version can discover the agent version.
 *
 * Hosted-multi-tenant route table:
 *
 *   /                              host home (anonymous landing; redirects signed-in to /dashboard)
 *   /dashboard                     signed-in host dashboard (Docos / users / orgs)
 *   /sign-in, /sign-out, /sign-up  auth (cookie locally; OAuth in prod per ADR-066, ADR-094)
 *   /onboarding/*                  first-run wizard (ADR-073). Agent variants retired by decision_01KRKZM14WNA1685GN0F12WCKM — use /cli/authorize.
 *   /cli/authorize                 Vercel-style browser-authorize handoff for `doco login` (decision_01KRKZM14WNA1685GN0F12WCKM)
 *   /agents, /agents/new           agent self-service (ADR-071)
 *   /new-doco, /new-org            self-service create flows (ADR-067)
 *   /:owner                        owner profile + Docos
 *   /:owner/:doco                  per-Doco recent + search input
 *   /:owner/:doco/:type            per-Doco entity list (short form; ADR-120)
 *   /:owner/:doco/:type/:id        per-Doco entity detail (id is the ULID; scope also resolves by name)
 *   /:owner/:doco/e/:type[/id]     legacy /e/ shape — 301-redirects to short form
 *   /:owner/:doco/search           per-Doco search (richer results — GPR / age / lifecycle)
 *   /:owner/:doco/lint             per-Doco lint (includes auto-reindex watcher status; ADR-123)
 *   /:owner/:doco/coverage         per-Doco drift (ADR-090)
 *   /:owner/:doco/settings         per-Doco settings (admin only; danger zone soft-delete; ADR-124)
 *   /:owner/:doco/scopes           per-Doco scope list (Edit button — not chevron — for instructions)
 *   /:owner/:doco/scopes/new       per-Doco add a scope (templates + custom form)
 *   /:owner/:doco/constitution     per-Doco Constitution (mandatory scope + rules; ADR-129)
 *   /:owner/:doco/status.json      per-Doco status (connection signal for agent footer line)
 *   /:owner/:doco/api/*            per-Doco capture + update endpoints
 *                                  (decisions / intents / evos / settings; ADR-128 added evos.json)
 *   /api/suggest-scopes            LLM scope suggestions
 *
 * Per-Doco URL collisions are prevented by `PER_DOCO_RESERVED_SLUGS` in
 * @doco/shared/url-conventions.ts — every static subpath here MUST be in
 * that set (enforced by `pnpm --filter @doco/web lint:routes`).
 */
export default [
  index("routes/_index.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  // Auth
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("sign-up", "routes/sign-up.tsx"),
  // GitHub OAuth (ADR-095)
  route("auth/github", "routes/auth.github.tsx"),
  route("auth/github/callback", "routes/auth.github.callback.tsx"),
  // Self-service create
  route("new-doco", "routes/new-doco.tsx"),
  route("new-org", "routes/new-org.tsx"),
  // Onboarding
  route("onboarding/join", "routes/onboarding.join._index.tsx"),
  route("onboarding/join/human", "routes/onboarding.join.human.tsx"),
  route("onboarding/join/agent", "routes/onboarding.join.agent.tsx"),
  route("onboarding/join/agent.txt", "routes/onboarding.join.agent[.]txt.tsx"),
  route("onboarding/join/agent.json", "routes/onboarding.join.agent[.]json.tsx"),
  route("onboarding/create", "routes/onboarding.create._index.tsx"),
  route("onboarding/create/human", "routes/onboarding.create.human.tsx"),
  // /onboarding/create/agent.* + /claim/<token> retired by
  // decision_01KRKZM14WNA1685GN0F12WCKM — agent-initiated Doco creation
  // now goes through /cli/authorize via `doco login --create <slug>`.
  // Agents
  route("agents", "routes/agents._index.tsx"),
  route("agents/new", "routes/agents.new.tsx"),
  // API
  route("api/suggest-scopes", "routes/api.suggest-scopes.tsx"),
  route("api/v1/agent-bootstrap", "routes/api.v1.agent-bootstrap.tsx"),
  route("api/v1/agent-reference", "routes/api.v1.agent-reference.tsx"),
  // CLI authorization (decision_01KRKZM14WNA1685GN0F12WCKM).
  route("api/v1/cli/device-init", "routes/api.v1.cli.device-init.tsx"),
  route("api/v1/cli/device-exchange", "routes/api.v1.cli.device-exchange.tsx"),
  route("cli/authorize", "routes/cli.authorize.tsx"),
  // ID-based lookup + redirect: the doco_id is immortal across renames
  // and ownership transfers; the slug is not. Agents that record the
  // ID once can resolve to the current canonical slug at request time.
  route("api/v1/docos/:docoId.json", "routes/api.v1.docos.$docoId[.]json.tsx"),
  route("by-id/:docoId/*", "routes/by-id.$docoId.$.tsx"),
  // Owner + per-Doco
  route(":ownerSlug", "routes/$ownerSlug._index.tsx"),
  route(":ownerSlug/:docoSlug", "routes/$ownerSlug.$docoSlug._index.tsx"),
  route(":ownerSlug/:docoSlug/status.json", "routes/$ownerSlug.$docoSlug.status[.]json.tsx"),
  route(":ownerSlug/:docoSlug/settings", "routes/$ownerSlug.$docoSlug.settings.tsx"),
  route(":ownerSlug/:docoSlug/api/decisions.json", "routes/$ownerSlug.$docoSlug.api.decisions[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/decisions/:id.json", "routes/$ownerSlug.$docoSlug.api.decisions.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/intents/:id.json", "routes/$ownerSlug.$docoSlug.api.intents.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/rules/:id.json", "routes/$ownerSlug.$docoSlug.api.rules.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/actions/:id.json", "routes/$ownerSlug.$docoSlug.api.actions.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/reasoning/:id.json", "routes/$ownerSlug.$docoSlug.api.reasoning.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/references/:id.json", "routes/$ownerSlug.$docoSlug.api.references.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes/:id.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes.json", "routes/$ownerSlug.$docoSlug.api.scopes[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/intents.json", "routes/$ownerSlug.$docoSlug.api.intents[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/actions.json", "routes/$ownerSlug.$docoSlug.api.actions[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/rules.json", "routes/$ownerSlug.$docoSlug.api.rules[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/reasoning.json", "routes/$ownerSlug.$docoSlug.api.reasoning[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/references.json", "routes/$ownerSlug.$docoSlug.api.references[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/evals.json", "routes/$ownerSlug.$docoSlug.api.evals[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/settings.json", "routes/$ownerSlug.$docoSlug.api.settings[.]json.tsx"),
  // Plain-prose specs for the .json endpoints — one parametrized route handles
  // decisions / intents / scopes / settings.
  route(":ownerSlug/:docoSlug/api/:type.txt", "routes/$ownerSlug.$docoSlug.api.$type[.]txt.tsx"),
  // Audit-events log (decision_01KRKESCBTYG4005VMPKYNYR53).
  route(":ownerSlug/:docoSlug/api/audit.json", "routes/$ownerSlug.$docoSlug.api.audit[.]json.tsx"),
  route(":ownerSlug/:docoSlug/activity", "routes/$ownerSlug.$docoSlug.activity.tsx"),
  // Legacy /e/:type URLs — 301-redirect to the short form below.
  // Per `ship-short-entity-urls` Intent + ADR.
  route(":ownerSlug/:docoSlug/e/:type", "routes/$ownerSlug.$docoSlug.e.$type._index.tsx"),
  route(":ownerSlug/:docoSlug/e/:type/:id", "routes/$ownerSlug.$docoSlug.e.$type.$id.tsx"),
  // Feature routes — registered BEFORE the catch-all :type below so they win
  // the match. (React Router prefers static segments but explicit order is
  // belt-and-suspenders.)
  route(":ownerSlug/:docoSlug/search", "routes/$ownerSlug.$docoSlug.search.tsx"),
  route(":ownerSlug/:docoSlug/search.json", "routes/$ownerSlug.$docoSlug.search[.]json.tsx"),
  route(":ownerSlug/:docoSlug/lint", "routes/$ownerSlug.$docoSlug.lint.tsx"),
  route(":ownerSlug/:docoSlug/coverage", "routes/$ownerSlug.$docoSlug.coverage.tsx"),
  route(":ownerSlug/:docoSlug/scopes", "routes/$ownerSlug.$docoSlug.scopes._index.tsx"),
  route(":ownerSlug/:docoSlug/scopes/new", "routes/$ownerSlug.$docoSlug.scopes.new.tsx"),
  route(":ownerSlug/:docoSlug/scopes/:id/edit", "routes/$ownerSlug.$docoSlug.scopes.$id.edit.tsx"),
  route(":ownerSlug/:docoSlug/constitution", "routes/$ownerSlug.$docoSlug.constitution.tsx"),
  route(":ownerSlug/:docoSlug/rules/new", "routes/$ownerSlug.$docoSlug.rules.new.tsx"),
  // Short-form entity routes. `:type` is validated by the loader; reserved
  // feature slugs above win the match for the static paths.
  route(":ownerSlug/:docoSlug/:type", "routes/$ownerSlug.$docoSlug.$type._index.tsx"),
  route(":ownerSlug/:docoSlug/:type/:id", "routes/$ownerSlug.$docoSlug.$type.$id.tsx"),
] satisfies RouteConfig;
