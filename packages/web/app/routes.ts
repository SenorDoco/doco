import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Doco web routes. Hosted-multi-tenant only (per ADR-092 + ADR-093).
 *
 * Routing model: this file is the canonical config (RR v7 config-based
 * routing). File-based routing (`@react-router/fs-routes`) is NOT in
 * use — the explicit manual table doubles as a prose-readable index
 * of the URL surface, grouped by area.
 *
 * Agent-route policy: when there's an HTML route whose path has an `agent`
 * segment, register `<path>.txt` (plain-prose docs for agents) AND
 * `<path>.json` (resource route — clean JSON POST endpoint, no document
 * render) as siblings. The HTML route must advertise both via
 * `<link rel="alternate">` in its `links()` export so an agent that lands
 * on the browser version can discover the agent version.
 *
 * Info-only agent paths can ship as `.txt` only — no HTML, no `.json` —
 * when the page is one screen of instructions and there is no state to
 * mutate. /onboarding/create/agent.txt is the standing example.
 *
 * Hosted-multi-tenant route table:
 *
 *   /                              host home (anonymous landing; redirects signed-in to /dashboard)
 *   /dashboard                     signed-in host dashboard (docos / users / orgs)
 *   /sign-in, /sign-out, /sign-up  auth (cookie locally; OAuth in prod per ADR-066, ADR-094)
 *   /onboarding/*                  first-run wizard (ADR-073). Agents POST /api/v1/docos.json directly; humans use the web flow.
 *   /invite/:code                  Human-only invite landing — signed-in humans accept (adds them to doco_users); signed-out humans bounce through GitHub. Agents read the sibling /invite/:code/agent.txt for the MCP-OAuth path instead.
 *   (agent self-service: install the per-Doco MCP connector at /mcp/:handle; OAuth dance kicks off automatically)
 *   /new-doco, /new-org            self-service create flows (ADR-067)
 *   /:owner                        owner profile + docos
 *   /:owner/:doco                  per-Doco recent + search input
 *   /:owner/:doco/:type            per-Doco entity list (short form; ADR-120)
 *   /:owner/:doco/:type/:id        per-Doco entity detail (id is the ULID; scope also resolves by name)
 *   /:owner/:doco/search           per-Doco search (richer results — GPR / age / lifecycle)
 *   /:owner/:doco/chat.json        Doco-wide Señor Doco chat endpoint for signed-in humans
 *   /:owner/:doco/settings         per-Doco settings (admin only; danger zone soft-delete; ADR-124)
 *   /:owner/:doco/scopes           per-Doco scope list (Edit button — not chevron — for instructions)
 *   /:owner/:doco/scopes/new       per-Doco add a scope (templates + custom form)
 *   /:owner/:doco/scopes/:id       per-Doco scope detail+edit (merged) — including the Global scope (formerly /constitution; renamed per decision_01KRPNZY7W6CCMYNKGND67BP0B)
 *   /:owner/:doco/scopes/:id/rules/new         standalone add rule page for scope rules
 *   /:owner/:doco/scopes/:id/abandon           standalone Danger Zone confirmation
 *   /:owner/:doco/status.json      per-Doco status (connection signal for agent footer line)
 *   /:owner/:doco/api/*            per-Doco capture + update endpoints
 *                                  (decisions / intents / evos / settings; ADR-128 added evos.json)
 *   /api/suggest-scopes            LLM scope suggestions
 *
 * Per-Doco URL collisions are prevented by `PER_DOCO_RESERVED_SLUGS` in
 * @doco/shared/url-conventions.ts — every static subpath here MUST be in
 * that set.
 */
export default [
  index("routes/_index.tsx"),
  // Agent-discovery entry points at the host root (decision pending):
  // an agent told "let's start using Doco" who lands on doco.to with no
  // prior context probes /llms.txt and /robots.txt before guessing other
  // paths. Both point at /llms.txt as the canonical agent entry.
  route("llms.txt", "routes/llms[.]txt.tsx"),
  route("robots.txt", "routes/robots[.]txt.tsx"),
  // Common probes agents try when told to "follow the wizard". Each
  // bounces to /llms.txt instead of 404-ing so the agent finds the
  // real recipe instead of giving up and asking the human.
  route("docs", "routes/agent-probes[.]ts.tsx", { id: "probe-docs" }),
  route("setup", "routes/agent-probes[.]ts.tsx", { id: "probe-setup" }),
  route("new", "routes/agent-probes[.]ts.tsx", { id: "probe-new" }),
  route("agent", "routes/agent-probes[.]ts.tsx", { id: "probe-agent" }),
  route("ai", "routes/agent-probes[.]ts.tsx", { id: "probe-ai" }),
  route("getting-started", "routes/agent-probes[.]ts.tsx", { id: "probe-getting-started" }),
  route("install", "routes/agent-probes[.]ts.tsx", { id: "probe-install" }),
  route("connect", "routes/agent-probes[.]ts.tsx", { id: "probe-connect" }),
  route("api", "routes/agent-probes[.]ts.tsx", { id: "probe-api" }),
  route("api/docs", "routes/agent-probes[.]ts.tsx", { id: "probe-api-docs" }),
  route("dashboard", "routes/dashboard.tsx"),
  // Auth
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.tsx"),
  route("sign-up", "routes/sign-up.tsx"),
  // GitHub OAuth (ADR-095)
  route("auth/github", "routes/auth.github.tsx"),
  route("auth/github/callback", "routes/auth.github.callback.tsx"),
  // Dev-only bypass for testing: gated on DOCO_DEV_AUTH=1.
  route("auth/dev-signin", "routes/auth.dev-signin.tsx"),
  // OAuth 2.1 authorization server (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).
  // Metadata endpoints are spec'd by RFC 8414 + RFC 9728 and discovered
  // by every MCP client that lands on /mcp without a valid bearer.
  route(
    ".well-known/oauth-authorization-server",
    "routes/oauth-metadata-authorization-server.tsx",
  ),
  route(
    ".well-known/oauth-protected-resource",
    "routes/oauth-metadata-protected-resource.tsx",
  ),
  // OAuth 2.1 authorization server endpoints. The runtime hits these
  // via the metadata document above; the user sees /oauth/authorize
  // in their browser when a runtime requests Doco access.
  route("oauth/register", "routes/oauth.register.tsx"),
  route("oauth/authorize", "routes/oauth.authorize.tsx"),
  route("oauth/token", "routes/oauth.token.tsx"),
  route("oauth/revoke", "routes/oauth.revoke.tsx"),
  // Self-service create
  route("new-doco", "routes/new-doco.tsx"),
  route("new-org", "routes/new-org.tsx"),
  route("orgs", "routes/orgs._index.tsx"),
  route("users", "routes/users.tsx"),
  // Onboarding (human paths only — agents authenticate via OAuth +
  // install the MCP connector at /mcp/<handle>, no recipe to walk
  // through). decision_01KS14CW9ZN23FF5CGG0Z7TH4G.
  route("onboarding/join", "routes/onboarding.join._index.tsx"),
  route("onboarding/join/human", "routes/onboarding.join.human.tsx"),
  route("onboarding/create", "routes/onboarding.create._index.tsx"),
  route("onboarding/create/human", "routes/onboarding.create.human.tsx"),
  // API
  route("api/suggest-scopes", "routes/api.suggest-scopes.tsx"),
  // MCP server (Streamable HTTP transport). One MCP server per Doco —
  // the runtime installs https://doco.to/mcp/<handle>. Auth is the
  // OAuth 2.1 access token (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).
  // /mcp alone returns the help/discovery doc and a 400 to POSTs
  // (it can't disambiguate which Doco the call belongs to).
  route("mcp", "routes/mcp.tsx", { id: "mcp-help" }),
  route("mcp/:handle", "routes/mcp.tsx", { id: "mcp" }),
  route("invite/:code", "routes/invite.$code.tsx"),
  // Agent-readable companion to /invite/:code. Agents that get pasted
  // an invite URL ("redeem this") fetch this to learn the MCP-OAuth
  // path — the invite URL itself is browser-only.
  route("invite/:code/agent.txt", "routes/invite.$code.agent[.]txt.tsx"),
  // ID-based lookup: the doco_id is immortal across renames and
  // ownership transfers. Agents that record the ULID resolve to the
  // current canonical handle at request time.
  route("api/v1/docos/:docoId.json", "routes/api.v1.docos.$docoId[.]json.tsx"),
  // Per-Doco routes: every Doco lives at `/<doco-id>/...` where
  // doco-id is the handle. `normalizeDocoParams` resolves the URL
  // param to a row. There is no owner profile page; the dashboard
  // is the single signed-in landing.
  route(":docoId", "routes/$ownerSlug.$docoSlug._index.tsx"),
  route(":docoId/status.json", "routes/$ownerSlug.$docoSlug.status[.]json.tsx"),
  route(":docoId/settings", "routes/$ownerSlug.$docoSlug.settings.tsx"),
  route(":docoId/invites", "routes/$ownerSlug.$docoSlug.invites.tsx"),
  route(":docoId/api/invites.json", "routes/$ownerSlug.$docoSlug.api.invites[.]json.tsx"),
  route(":docoId/api/decisions.json", "routes/$ownerSlug.$docoSlug.api.decisions[.]json.tsx"),
  route(
    ":docoId/api/decisions/:id.json",
    "routes/$ownerSlug.$docoSlug.api.decisions.$id[.]json.tsx",
  ),
  route(":docoId/api/intents/:id.json", "routes/$ownerSlug.$docoSlug.api.intents.$id[.]json.tsx"),
  route(":docoId/api/rules/:id.json", "routes/$ownerSlug.$docoSlug.api.rules.$id[.]json.tsx"),
  route(":docoId/api/actions/:id.json", "routes/$ownerSlug.$docoSlug.api.actions.$id[.]json.tsx"),
  route(":docoId/api/logs/:id.json", "routes/$ownerSlug.$docoSlug.api.logs.$id[.]json.tsx"),
  route(
    ":docoId/api/references/:id.json",
    "routes/$ownerSlug.$docoSlug.api.references.$id[.]json.tsx",
  ),
  route(":docoId/api/scopes/:id.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id[.]json.tsx"),
  route(
    ":docoId/api/scopes/:id/rules.json",
    "routes/$ownerSlug.$docoSlug.api.scopes.$id.rules[.]json.tsx",
  ),
  // v7 scope bulk verbs.
  route(
    ":docoId/api/scopes/:id/activate.json",
    "routes/$ownerSlug.$docoSlug.api.scopes.$id.activate[.]json.tsx",
  ),
  route(
    ":docoId/api/scopes/:id/draft.json",
    "routes/$ownerSlug.$docoSlug.api.scopes.$id.draft[.]json.tsx",
  ),
  route(
    ":docoId/api/scopes/:id/validate.json",
    "routes/$ownerSlug.$docoSlug.api.scopes.$id.validate[.]json.tsx",
  ),
  route(
    ":docoId/api/scopes/:id/excluded-rules.json",
    "routes/$ownerSlug.$docoSlug.api.scopes.$id.excluded-rules[.]json.tsx",
  ),
  route(":docoId/api/scopes.json", "routes/$ownerSlug.$docoSlug.api.scopes[.]json.tsx"),
  route(":docoId/api/principals.json", "routes/$ownerSlug.$docoSlug.api.principals[.]json.tsx"),
  route(":docoId/api/intents.json", "routes/$ownerSlug.$docoSlug.api.intents[.]json.tsx"),
  route(":docoId/api/actions.json", "routes/$ownerSlug.$docoSlug.api.actions[.]json.tsx"),
  route(":docoId/api/logs.json", "routes/$ownerSlug.$docoSlug.api.logs[.]json.tsx"),
  route(":docoId/api/rules.json", "routes/$ownerSlug.$docoSlug.api.rules[.]json.tsx"),
  route(":docoId/api/references.json", "routes/$ownerSlug.$docoSlug.api.references[.]json.tsx"),
  route(":docoId/api/evals.json", "routes/$ownerSlug.$docoSlug.api.evals[.]json.tsx"),
  route(":docoId/api/states.json", "routes/$ownerSlug.$docoSlug.api.states[.]json.tsx"),
  route(":docoId/api/settings.json", "routes/$ownerSlug.$docoSlug.api.settings[.]json.tsx"),
  route(":docoId/api/:type.txt", "routes/$ownerSlug.$docoSlug.api.$type[.]txt.tsx"),
  route(":docoId/api/audit.json", "routes/$ownerSlug.$docoSlug.api.audit[.]json.tsx"),
  route(
    ":docoId/api/admin/apply-template-updates.json",
    "routes/$ownerSlug.$docoSlug.api.admin.apply-template-updates[.]json.tsx",
  ),
  route(":docoId/activity", "routes/$ownerSlug.$docoSlug.activity.tsx"),
  route(":docoId/chat.json", "routes/$ownerSlug.$docoSlug.chat[.]json.tsx"),
  route(":docoId/search", "routes/$ownerSlug.$docoSlug.search.tsx"),
  route(":docoId/search.json", "routes/$ownerSlug.$docoSlug.search[.]json.tsx"),
  route(":docoId/onboarding/agent", "routes/$ownerSlug.$docoSlug.onboarding.agent.tsx"),
  route(":docoId/scopes", "routes/$ownerSlug.$docoSlug.scopes._index.tsx"),
  route(":docoId/scopes/new", "routes/$ownerSlug.$docoSlug.scopes.new.tsx"),
  route(":docoId/scopes/:id", "routes/$ownerSlug.$docoSlug.scopes.$id._index.tsx"),
  route(":docoId/scopes/:id/rules/new", "routes/$ownerSlug.$docoSlug.scopes.$id.rules.new.tsx"),
  route(":docoId/scopes/:id/abandon", "routes/$ownerSlug.$docoSlug.scopes.$id.abandon.tsx"),
  route(":docoId/rules/new", "routes/$ownerSlug.$docoSlug.rules.new.tsx"),
  // Short-form entity routes. `:type` is validated by the loader; reserved
  // feature paths above win the match for the static paths.
  route(":docoId/:type", "routes/$ownerSlug.$docoSlug.$type._index.tsx"),
  route(":docoId/:type/:id", "routes/$ownerSlug.$docoSlug.$type.$id.tsx"),
] satisfies RouteConfig;
