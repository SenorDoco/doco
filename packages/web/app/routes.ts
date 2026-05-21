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
 * mutate.
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
 *   /<doco-handle>                 per-Doco recent + search input
 *   /<doco-handle>/<type>          per-Doco entity list (short form; ADR-120)
 *   /<doco-handle>/<type>/<id>     per-Doco entity detail (id is the ULID)
 *   /<doco-handle>/search          per-Doco search (richer results — GPR / age / lifecycle)
 *   /<doco-handle>/settings        per-Doco settings (admin only; danger zone soft-delete; ADR-124)
 *   /<doco-handle>/constitution    per-Doco constitution page: guidance_articles + node_authoring_articles
 *   /<doco-handle>/status.json     per-Doco status (connection signal for agent footer line)
 *   /<doco-handle>/api/*           per-Doco capture + update endpoints
 *                                  (decisions / intents / settings; ADR-128)
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
  route(".well-known/oauth-authorization-server", "routes/oauth-metadata-authorization-server.tsx"),
  // OAuth 2.1 authorization server endpoints. The runtime hits these
  // via the metadata document above; the user sees /oauth/authorize
  // in their browser when a runtime requests Doco access.
  route("oauth/register", "routes/oauth.register.tsx"),
  route("oauth/authorize", "routes/oauth.authorize.tsx"),
  route("oauth/token", "routes/oauth.token.tsx"),
  route("oauth/revoke", "routes/oauth.revoke.tsx"),
  // Device Authorization Grant (RFC 8628). For agents that can't drive
  // a localhost-redirect flow: they POST here, get back a short
  // user_code, show it to the human, and poll /oauth/token while the
  // human approves at /device.
  route("oauth/device_authorization", "routes/oauth.device-authorization.tsx"),
  route("device", "routes/device.tsx"),
  // Public agent-protocol prose. Replaces the MCP `resources/read`
  // delivery path during the period the MCP layer is removed.
  route("protocol/canonical-instructions", "routes/protocol.canonical-instructions.tsx"),
  // Step-by-step OAuth recipe for agents that aren't going through an
  // MCP runtime. Covers localhost-loopback (Recipe A) + Device Flow
  // (Recipe B). Public; served as text/markdown.
  route("protocol/agent-oauth-recipe", "routes/protocol.agent-oauth-recipe.tsx"),
  // Self-service create. The doco-create flow is a 4-step wizard;
  // step 4 lives under :docoId/welcome alongside the per-Doco routes.
  route("new-doco", "routes/new-doco.tsx"),
  route("new-doco/constitution", "routes/new-doco.constitution.tsx"),
  route("new-doco/template", "routes/new-doco.template.tsx"),
  route("new-org", "routes/new-org.tsx"),
  route("orgs", "routes/orgs._index.tsx"),
  // Per-Org home — mirrors the Doco home page but aggregates across
  // every Doco the org owns (docos list, node-type/lifecycle facets,
  // activity heatmap + feed, top contributors, members).
  route("orgs/:orgHandle", "routes/orgs.$orgHandle._index.tsx"),
  // Org-level constitution: applies to every Doco owned by the org.
  // Same shape as the per-Doco constitution at /:docoHandle/constitution.
  // Standalone add pages live one level deeper.
  route("orgs/:orgHandle/constitution", "routes/orgs.$orgHandle.constitution.tsx"),
  route(
    "orgs/:orgHandle/constitution/guidance/new",
    "routes/orgs.$orgHandle.constitution.guidance.new.tsx",
  ),
  route(
    "orgs/:orgHandle/constitution/node-authoring/new",
    "routes/orgs.$orgHandle.constitution.node-authoring.new.tsx",
  ),
  route("users", "routes/users.tsx"),
  // Onboarding (human paths only — agents authenticate via OAuth +
  // install the MCP connector at /mcp/<handle>, no recipe to walk
  // through). decision_01KS14CW9ZN23FF5CGG0Z7TH4G.
  route("onboarding/join", "routes/onboarding.join._index.tsx"),
  route("onboarding/join/human", "routes/onboarding.join.human.tsx"),
  // API
  route("invite/:code", "routes/invite.$code.tsx"),
  // Agent-readable companion to /invite/:code. Agents that get pasted
  // an invite URL ("redeem this") fetch this to learn the MCP-OAuth
  // path — the invite URL itself is browser-only.
  route("invite/:code/agent.txt", "routes/invite.$code.agent[.]txt.tsx"),
  // ID-based lookup: the doco_id is immortal across renames and
  // ownership transfers. Agents that record the ULID resolve to the
  // current canonical handle at request time.
  route("api/v1/docos/:docoId.json", "routes/api.v1.docos.$docoId[.]json.tsx"),
  // v15 creation endpoints (decision_01KS3DW9C2KN2X7Z80R18H1RAX).
  // POST-only, auto-suffix on collision, return 201 + the (possibly
  // suffixed) handle.
  route("api/v1/orgs.json", "routes/api.v1.orgs[.]json.tsx"),
  route("api/v1/docos.json", "routes/api.v1.docos[.]json.tsx"),
  // Agent bootstrap. Returns the canonical-instructions prose plus the
  // union of org + Doco constitutions the caller can read. Auth-aware:
  // anonymous callers get public-Doco constitutions only.
  route("api/v1/agent-bootstrap.json", "routes/api.v1.agent-bootstrap[.]json.tsx"),
  // Per-Doco routes: every Doco lives at `/<doco-id>/...` where
  // doco-id is the handle. `normalizeDocoParams` resolves the URL
  // param to a row. There is no owner profile page; the dashboard
  // is the single signed-in landing.
  route(":docoId", "routes/$docoHandle._index.tsx"),
  route(":docoId/welcome", "routes/$docoHandle.welcome.tsx"),
  route(":docoId/status.json", "routes/$docoHandle.status[.]json.tsx"),
  route(":docoId/settings", "routes/$docoHandle.settings.tsx"),
  route(":docoId/constitution", "routes/$docoHandle.constitution.tsx"),
  route(":docoId/constitution/guidance/new", "routes/$docoHandle.constitution.guidance.new.tsx"),
  route(
    ":docoId/constitution/node-authoring/new",
    "routes/$docoHandle.constitution.node-authoring.new.tsx",
  ),
  route(":docoId/invites", "routes/$docoHandle.invites.tsx"),
  route(":docoId/api/invites.json", "routes/$docoHandle.api.invites[.]json.tsx"),
  // Per-entity detail (PATCH/GET) routes. Most use the makeUpdateRoute
  // factory; decisions.$id has a custom action (ADR promotion logic).
  route(":docoId/api/decisions/:id.json", "routes/$docoHandle.api.decisions.$id[.]json.tsx"),
  route(":docoId/api/intents/:id.json", "routes/$docoHandle.api.intents.$id[.]json.tsx"),
  route(":docoId/api/rules/:id.json", "routes/$docoHandle.api.rules.$id[.]json.tsx"),
  route(
    ":docoId/api/guidance_articles/:id.json",
    "routes/$docoHandle.api.guidance_articles.$id[.]json.tsx",
  ),
  route(
    ":docoId/api/node_authoring_articles/:id.json",
    "routes/$docoHandle.api.node_authoring_articles.$id[.]json.tsx",
  ),
  route(":docoId/api/actions/:id.json", "routes/$docoHandle.api.actions.$id[.]json.tsx"),
  route(":docoId/api/logs/:id.json", "routes/$docoHandle.api.logs.$id[.]json.tsx"),
  route(":docoId/api/references/:id.json", "routes/$docoHandle.api.references.$id[.]json.tsx"),
  // Special-cased capture routes that need custom logic — listed BEFORE
  // the generic `:type.json` dispatcher so the static segment wins.
  route(":docoId/api/principals.json", "routes/$docoHandle.api.principals[.]json.tsx"),
  route(":docoId/api/settings.json", "routes/$docoHandle.api.settings[.]json.tsx"),
  route(":docoId/api/audit.json", "routes/$docoHandle.api.audit[.]json.tsx"),
  // Generic capture dispatcher. Handles decisions, intents, actions,
  // references, rules, guidance_articles, node_authoring_articles, logs,
  // evals, states via CAPTURE_REGISTRY in the route file. Adding a new
  // simple-capture entity type is one registry row; no new route needed.
  route(":docoId/api/:type.json", "routes/$docoHandle.api.$type[.]json.tsx"),
  route(":docoId/api/:type.txt", "routes/$docoHandle.api.$type[.]txt.tsx"),
  route(":docoId/activity", "routes/$docoHandle.activity.tsx"),
  route(":docoId/graph-node-details.json", "routes/$docoHandle.graph-node-details[.]json.tsx"),
  route(":docoId/search", "routes/$docoHandle.search.tsx"),
  route(":docoId/search.json", "routes/$docoHandle.search[.]json.tsx"),
  route(":docoId/onboarding/agent", "routes/$docoHandle.onboarding.agent.tsx"),
  route(":docoId/rules/new", "routes/$docoHandle.rules.new.tsx"),
  // Short-form entity routes. `:type` is validated by the loader; reserved
  // feature paths above win the match for the static paths.
  route(":docoId/:type", "routes/$docoHandle.$type._index.tsx"),
  route(":docoId/:type/:id", "routes/$docoHandle.$type.$id.tsx"),
] satisfies RouteConfig;
