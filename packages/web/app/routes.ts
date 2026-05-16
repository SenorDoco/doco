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
 *   /invite/:code                  browser landing for a Doco invite — signed-in human accepts and gets their own DOCO_KEY.
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
  // and get back a `{doco_id, doco_url, doco_key, invite_url}` envelope.
  // The invite_url is sharable for 7 days by default; a recipient
  // (human via /invite/<code> or agent via the redeem.json endpoint)
  // claims their own personal access key. The old agent-link / device-
  // code flow is retired — that pattern fought every conservative
  // permission classifier and lost.
  route("api/v1/docos.json", "routes/api.v1.docos[.]json.tsx"),
  route(
    "api/v1/invites/:code/redeem.json",
    "routes/api.v1.invites.$code.redeem[.]json.tsx",
  ),
  route("invite/:code", "routes/invite.$code.tsx"),
  // ID-based lookup + redirect: the doco_id is immortal across renames
  // and ownership transfers; the slug is not. Agents that record the
  // ID once can resolve to the current canonical slug at request time.
  route("api/v1/docos/:docoId.json", "routes/api.v1.docos.$docoId[.]json.tsx"),
  route("by-id/:docoId/status.json", "routes/by-id.$docoId.status[.]json.tsx"),
  route("by-id/:docoId/settings", "routes/by-id.$docoId.settings.tsx"),
  route("by-id/:docoId/api/:type.json", "routes/by-id.$docoId.api.$type[.]json.tsx"),
  route("by-id/:docoId/api/:type/:id.json", "routes/by-id.$docoId.api.$type.$id[.]json.tsx"),
  route("by-id/:docoId/api/:type.txt", "routes/by-id.$docoId.api.$type[.]txt.tsx"),
  route("by-id/:docoId/search.json", "routes/by-id.$docoId.search[.]json.tsx"),
  route("by-id/:docoId/scopes/new", "routes/by-id.$docoId.scopes.new.tsx"),
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG) scope bulk verbs — by-id
  // shorthand that the splat would otherwise miss because the slug-form
  // catch-all is more specific. Each re-exports from the splat so the
  // 308 to the canonical URL still runs.
  route("by-id/:docoId/api/scopes/:id/activate.json", "routes/by-id.$docoId.api.scopes.$id.activate[.]json.tsx"),
  route("by-id/:docoId/api/scopes/:id/draft.json", "routes/by-id.$docoId.api.scopes.$id.draft[.]json.tsx"),
  route("by-id/:docoId/api/scopes/:id/validate.json", "routes/by-id.$docoId.api.scopes.$id.validate[.]json.tsx"),
  route("by-id/:docoId/api/scopes/:id/excluded-rules.json", "routes/by-id.$docoId.api.scopes.$id.excluded-rules[.]json.tsx"),
  route("by-id/:docoId/:type/:id", "routes/by-id.$docoId.$type.$id.tsx"),
  route("by-id/:docoId/:type", "routes/by-id.$docoId.$type.tsx"),
  route("by-id/:docoId/*", "routes/by-id.$docoId.$.tsx"),
  // Agent access-URL family. The credential lives in the path; each
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
  route(":ownerSlug/:docoSlug/api/logs/:id.json", "routes/$ownerSlug.$docoSlug.api.logs.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/references/:id.json", "routes/$ownerSlug.$docoSlug.api.references.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes/:id.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes/:id/rules.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.rules[.]json.tsx"),
  // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG) scope bulk verbs.
  route(":ownerSlug/:docoSlug/api/scopes/:id/activate.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.activate[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes/:id/draft.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.draft[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes/:id/validate.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.validate[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes/:id/excluded-rules.json", "routes/$ownerSlug.$docoSlug.api.scopes.$id.excluded-rules[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/scopes.json", "routes/$ownerSlug.$docoSlug.api.scopes[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/principals.json", "routes/$ownerSlug.$docoSlug.api.principals[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/intents.json", "routes/$ownerSlug.$docoSlug.api.intents[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/actions.json", "routes/$ownerSlug.$docoSlug.api.actions[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/logs.json", "routes/$ownerSlug.$docoSlug.api.logs[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/rules.json", "routes/$ownerSlug.$docoSlug.api.rules[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/references.json", "routes/$ownerSlug.$docoSlug.api.references[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/evals.json", "routes/$ownerSlug.$docoSlug.api.evals[.]json.tsx"),
  // v7: State node POST endpoint.
  route(":ownerSlug/:docoSlug/api/states.json", "routes/$ownerSlug.$docoSlug.api.states[.]json.tsx"),
  route(":ownerSlug/:docoSlug/api/settings.json", "routes/$ownerSlug.$docoSlug.api.settings[.]json.tsx"),
  // Plain-prose specs for the .json endpoints — one parametrized route handles
  // decisions / intents / scopes / settings.
  route(":ownerSlug/:docoSlug/api/:type.txt", "routes/$ownerSlug.$docoSlug.api.$type[.]txt.tsx"),
  // Audit-events log (decision_01KRKESCBTYG4005VMPKYNYR53).
  route(":ownerSlug/:docoSlug/api/audit.json", "routes/$ownerSlug.$docoSlug.api.audit[.]json.tsx"),
  // Admin-only one-shot migration that brings managed scopes into
  // alignment with the current DEFAULT_SCOPE_TEMPLATES
  // (decision_01KRRD6QM7NN2EV56NZK96DNKY).
  route(
    ":ownerSlug/:docoSlug/api/admin/apply-template-updates.json",
    "routes/$ownerSlug.$docoSlug.api.admin.apply-template-updates[.]json.tsx",
  ),
  route(":ownerSlug/:docoSlug/activity", "routes/$ownerSlug.$docoSlug.activity.tsx"),
  // Feature routes — registered BEFORE the catch-all :type below so they win
  // the match. (React Router prefers static segments but explicit order is
  // belt-and-suspenders.)
  route(":ownerSlug/:docoSlug/search", "routes/$ownerSlug.$docoSlug.search.tsx"),
  route(":ownerSlug/:docoSlug/search.json", "routes/$ownerSlug.$docoSlug.search[.]json.tsx"),
  route(":ownerSlug/:docoSlug/scopes", "routes/$ownerSlug.$docoSlug.scopes._index.tsx"),
  route(":ownerSlug/:docoSlug/scopes/new", "routes/$ownerSlug.$docoSlug.scopes.new.tsx"),
  // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the merged scope page lives
  // at /scopes/:id; abandonment is a sibling page so the main scope
  // surface stays a coherent "edit everything else" view.
  route(":ownerSlug/:docoSlug/scopes/:id", "routes/$ownerSlug.$docoSlug.scopes.$id._index.tsx"),
  route(
    ":ownerSlug/:docoSlug/scopes/:id/intent/replace",
    "routes/$ownerSlug.$docoSlug.scopes.$id.intent.replace.tsx",
  ),
  route(
    ":ownerSlug/:docoSlug/scopes/:id/rules/new",
    "routes/$ownerSlug.$docoSlug.scopes.$id.rules.new.tsx",
  ),
  route(":ownerSlug/:docoSlug/scopes/:id/abandon", "routes/$ownerSlug.$docoSlug.scopes.$id.abandon.tsx"),
  route(":ownerSlug/:docoSlug/rules/new", "routes/$ownerSlug.$docoSlug.rules.new.tsx"),
  // Short-form entity routes. `:type` is validated by the loader; reserved
  // feature slugs above win the match for the static paths.
  route(":ownerSlug/:docoSlug/:type", "routes/$ownerSlug.$docoSlug.$type._index.tsx"),
  route(":ownerSlug/:docoSlug/:type/:id", "routes/$ownerSlug.$docoSlug.$type.$id.tsx"),
] satisfies RouteConfig;
