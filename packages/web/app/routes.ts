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
 *   /invite/:code                  browser landing for a Doco invite — signed-in human accepts and gets their own DOCO_ACCESS.
 *   /agents, /agents/new           agent self-service (ADR-071)
 *   /new-doco, /new-org            self-service create flows (ADR-067)
 *   /:owner                        owner profile + docos
 *   /:owner/:doco                  per-Doco recent + search input
 *   /:owner/:doco/:type            per-Doco entity list (short form; ADR-120)
 *   /:owner/:doco/:type/:id        per-Doco entity detail (id is the ULID; scope also resolves by name)
 *   /:owner/:doco/search           per-Doco search (richer results — GPR / age / lifecycle)
 *   /:owner/:doco/settings         per-Doco settings (admin only; danger zone soft-delete; ADR-124)
 *   /:owner/:doco/scopes           per-Doco scope list (Edit button — not chevron — for instructions)
 *   /:owner/:doco/scopes/new       per-Doco add a scope (templates + custom form)
 *   /:owner/:doco/scopes/:id       per-Doco scope detail+edit (merged) — including the Global scope (formerly /constitution; renamed per decision_01KRPNZY7W6CCMYNKGND67BP0B)
 *   /:owner/:doco/scopes/:id/intent/replace    standalone replace main intent page
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
  // /onboarding/create/agent is plain text only — the "Agent" leaf on
  // /onboarding/create routes straight here. After
  // decision_01KRKZM14WNA1685GN0F12WCKM the page is info-only (run
  // `doco login --create <slug>`), so the HTML and .json siblings
  // would just be ceremony around a one-screen instruction.
  route("onboarding/create/agent.txt", "routes/onboarding.create.agent[.]txt.tsx"),
  // Agents
  route("agents", "routes/agents._index.tsx"),
  route("agents/new", "routes/agents.new.tsx"),
  // API
  route("api/suggest-scopes", "routes/api.suggest-scopes.tsx"),
  route("api/v1/agent-bootstrap", "routes/api.v1.agent-bootstrap.tsx"),
  route("api/v1/agent-reference", "routes/api.v1.agent-reference.tsx"),
  // Anonymous Doco creation + invite-based collaboration. Any user
  // (agent or human) can POST /api/v1/docos.json with no prior auth
  // and get back a `{doco_id, doco_url, doco_access, invite_url}` envelope.
  // The invite_url is sharable for 7 days by default; a recipient
  // (human via /invite/<code> or agent via the redeem.json endpoint)
  // claims their own personal access credential. The old agent-link / device-
  // code flow is retired — that pattern fought every conservative
  // permission classifier and lost.
  route("api/v1/docos.json", "routes/api.v1.docos[.]json.tsx"),
  // Graceful trap for the retired browser-authorize / device-code
  // family. Stale-knowledge agents that still try /api/v1/agent-link/start
  // (or poll, or authorize) get a structured 410 with next_steps_for_agent
  // pointing at the current POST /api/v1/docos.json flow — first-call
  // recovery instead of 404 + docs re-read. See route file header.
  route("api/v1/agent-link/*", "routes/api.v1.agent-link.$.tsx"),
  route(
    "api/v1/invites/:code/redeem.json",
    "routes/api.v1.invites.$code.redeem[.]json.tsx",
  ),
  route("invite/:code", "routes/invite.$code.tsx"),
  // ID-based lookup: the doco_id is immortal across renames and
  // ownership transfers. Agents that record the ULID resolve to the
  // current canonical handle at request time. /by-id/<ULID>/* URLs
  // were the legacy aliases; the handle URL is now canonical so the
  // splat redirect family is gone — anyone holding a ULID hits this
  // endpoint to discover the current `doco_handle`.
  route("api/v1/docos/:docoId.json", "routes/api.v1.docos.$docoId[.]json.tsx"),
  // Legacy agent access-URL family. Older credentials live in the path; each
  // route 308-redirects to the canonical /by-id/<doco>/<rest> shape
  // with the credential preserved as `?_a=<cred>` so the destination
  // authenticates. Explicit per-leaf routes win React Router 7's rank
  // against the `:ownerSlug/:docoSlug/<literal>` patterns; the splat
  // catches anything else.
  route("agent/:cred/bootstrap.json", "routes/agent.$cred.bootstrap[.]json.tsx"),
  route("agent/:cred/search.json", "routes/agent.$cred.search[.]json.tsx"),
  route("agent/:cred/status.json", "routes/agent.$cred.status[.]json.tsx"),
  route("agent/:cred/api/:type.json", "routes/agent.$cred.api.$type[.]json.tsx"),
  route("agent/:cred/api/:type/:id.json", "routes/agent.$cred.api.$type.$id[.]json.tsx"),
  route("agent/:cred/*", "routes/agent.$cred.$.tsx"),
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
  route(":docoId/api/decisions/:id.json", "routes/$ownerSlug.$docoSlug.api.decisions.$id[.]json.tsx"),
  route(":docoId/api/intents/:id.json", "routes/$ownerSlug.$docoSlug.api.intents.$id[.]json.tsx"),
  route(":docoId/api/rules/:id.json", "routes/$ownerSlug.$docoSlug.api.rules.$id[.]json.tsx"),
  route(":docoId/api/actions/:id.json", "routes/$ownerSlug.$docoSlug.api.actions.$id[.]json.tsx"),
  route(":docoId/api/logs/:id.json", "routes/$ownerSlug.$docoSlug.api.logs.$id[.]json.tsx"),
  route(":docoId/api/references/:id.json", "routes/$ownerSlug.$docoSlug.api.references.$id[.]json.tsx"),
  route(":docoId/api/scopes/:id.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id[.]json.tsx"),
  route(":docoId/api/scopes/:id/rules.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.rules[.]json.tsx"),
  // v7 scope bulk verbs.
  route(":docoId/api/scopes/:id/activate.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.activate[.]json.tsx"),
  route(":docoId/api/scopes/:id/draft.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.draft[.]json.tsx"),
  route(":docoId/api/scopes/:id/validate.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.validate[.]json.tsx"),
  route(":docoId/api/scopes/:id/excluded-rules.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.excluded-rules[.]json.tsx"),
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
  route(":docoId/search", "routes/$ownerSlug.$docoSlug.search.tsx"),
  route(":docoId/search.json", "routes/$ownerSlug.$docoSlug.search[.]json.tsx"),
  route(":docoId/onboarding/agent", "routes/$ownerSlug.$docoSlug.onboarding.agent.tsx"),
  route(":docoId/scopes", "routes/$ownerSlug.$docoSlug.scopes._index.tsx"),
  route(":docoId/scopes/new", "routes/$ownerSlug.$docoSlug.scopes.new.tsx"),
  route(":docoId/scopes/:id", "routes/$ownerSlug.$docoSlug.scopes.$id._index.tsx"),
  route(
    ":docoId/scopes/:id/intent/replace",
    "routes/$ownerSlug.$docoSlug.scopes.$id.intent.replace.tsx",
  ),
  route(
    ":docoId/scopes/:id/rules/new",
    "routes/$ownerSlug.$docoSlug.scopes.$id.rules.new.tsx",
  ),
  route(":docoId/scopes/:id/abandon", "routes/$ownerSlug.$docoSlug.scopes.$id.abandon.tsx"),
  route(":docoId/rules/new", "routes/$ownerSlug.$docoSlug.rules.new.tsx"),
  // Short-form entity routes. `:type` is validated by the loader; reserved
  // feature paths above win the match for the static paths.
  route(":docoId/:type", "routes/$ownerSlug.$docoSlug.$type._index.tsx"),
  route(":docoId/:type/:id", "routes/$ownerSlug.$docoSlug.$type.$id.tsx"),
] satisfies RouteConfig;
