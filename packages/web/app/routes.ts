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
 *   /dashboard                     signed-in host dashboard (docos / users / workspaces)
 *   /feedback                      owner-only bug/idea report review page (clears the header flags)
 *   /mentor/feedback               legacy redirect → /feedback
 *   /users/<username>              signed-in user's tiny profile placeholder
 *   /sign-in, /sign-out, /sign-up  auth (cookie locally; OAuth in prod per ADR-066, ADR-094)
 *   /invite/:code                  Human-only invite landing — signed-in humans accept (adds them to doco_users); signed-out humans bounce through GitHub. Agents read the sibling /invite/:code/agent.txt for the MCP-OAuth path instead.
 *   /by-id/:docoId                 Stable Doco-id redirect to the current handle
 *   (agent self-service: install the hosted MCP connector at /mcp; OAuth dance kicks off automatically)
 *   /new-doco, /new-workspace            self-service create flows (ADR-067)
 *   /integrations                  group-chat integrations and channel-default authorization
 *   /workspaces/<workspace-handle>/settings    per-Workspace settings (owner only; danger-zone deletion)
 *   /<doco-handle>                 per-Doco recent + search input
 *   /<doco-handle>/<type>          per-Doco entity list (short form; ADR-120)
 *   /<doco-handle>/<type>/<id>     per-Doco entity detail (id is the ULID)
 *   /<doco-handle>/search          per-Doco search (richer results — GPR / age / lifecycle)
 *   /<doco-handle>/settings        per-Doco settings (admin only; danger zone soft-delete; ADR-124)
 *   /<doco-handle>/policies      per-Doco policies page (single `policies` table)
 *   /<doco-handle>/policies/<id> one policy's stable, linkable page (owner gets Modify + Revoke)
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
  route("api", "routes/agent-probes[.]ts.tsx", { id: "probe-api" }),
  route("api/docs", "routes/agent-probes[.]ts.tsx", { id: "probe-api-docs" }),
  route("dashboard", "routes/dashboard.tsx"),
  // Admin / staff-only dashboards. Auth check is in the loader of
  // each route file — the route table doesn't gate, it just lists.
  route("admin/agent-usage", "routes/admin.agent-usage.tsx"),
  // Health snapshot as JSON (200 ok/warning, 503 critical) for
  // uptime checkers + curl. Same auth gate as the dashboard.
  route("admin/agent-health.json", "routes/admin.agent-health[.]json.tsx"),
  // Vercel-Cron-hit endpoint that POSTs an alert payload to
  // DOCO_HEALTH_WEBHOOK_URL whenever the snapshot is non-OK.
  route("admin/agent-health-cron", "routes/admin.agent-health-cron.tsx"),
  // Vercel-Cron-hit endpoint that hard-deletes Docos tombstoned past the
  // 30-day soft-delete grace window (docos.deleted_at).
  route("admin/purge-deleted-docos", "routes/admin.purge-deleted-docos.tsx"),
  // Raw-row dump for diagnosing specific failed/stuck turns.
  // Returns the actual agent_turn_metrics / capture_timings rows
  // behind the aggregated health signals.
  route("admin/agent-debug.json", "routes/admin.agent-debug[.]json.tsx"),
  route("feedback", "routes/feedback.tsx"),
  // Legacy path — the page is now just /feedback; redirect old links.
  route("mentor/feedback", "routes/mentor.feedback.tsx"),
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
  // by every MCP client that lands on a workspace MCP endpoint without a valid bearer.
  route(".well-known/oauth-authorization-server", "routes/oauth-metadata-authorization-server.tsx"),
  route(".well-known/oauth-protected-resource", "routes/oauth-metadata-protected-resource.tsx"),
  // THE hosted MCP endpoint, at `/mcp` + its RFC 9728 metadata. One connection
  // per user; the session's reach comes from the token (an actor token reaches
  // every workspace the user belongs to, a workspace-scoped token pins one).
  // Registered BEFORE the :docoHandle catch-all so the literal `mcp` segment
  // matches first — otherwise a param route would capture it.
  route(
    ".well-known/oauth-protected-resource/mcp",
    "routes/oauth-metadata-protected-resource.mcp.tsx",
  ),
  route("mcp", "routes/mcp.tsx"),
  // OAuth 2.1 authorization server endpoints. The runtime hits these
  // via the metadata document above; the user sees /oauth/authorize
  // in their browser when a runtime requests Doco access.
  route("oauth/register", "routes/oauth.register.tsx"),
  route("oauth/authorize", "routes/oauth.authorize.tsx"),
  route("oauth/approved", "routes/oauth.approved.tsx"),
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
  // Self-service create. The doco-create flow starts with one form,
  // then continues under :docoHandle/welcome.
  route("new-doco", "routes/new-doco.tsx"),
  route("new-doco/template", "routes/new-doco.template.tsx"),
  route("new-workspace", "routes/new-workspace.tsx"),
  route("workspaces", "routes/workspaces._index.tsx"),
  // Per-Workspace home — mirrors the Doco home page but aggregates across
  // every Doco the workspace owns (docos list, node-type/lifecycle facets,
  // activity heatmap + feed, top contributors, members).
  route("workspaces/:workspaceHandle/settings", "routes/workspaces.$workspaceHandle.settings.tsx"),
  route(
    "workspaces/:workspaceHandle/integrations",
    "routes/workspaces.$workspaceHandle.integrations.tsx",
  ),
  route("workspaces/:workspaceHandle", "routes/workspaces.$workspaceHandle._index.tsx"),
  // Cross-Doco semantic search across every Doco the workspace owns.
  route("workspaces/:workspaceHandle/search", "routes/workspaces.$workspaceHandle.search.tsx"),
  route("users", "routes/users.tsx"),
  route("integrations", "routes/integrations.tsx"),
  route("integrations/slack/install", "routes/integrations.slack.install.tsx"),
  route("integrations/slack/callback", "routes/integrations.slack.callback.tsx"),
  route("integrations/slack/link", "routes/integrations.slack.link.tsx"),
  route("integrations/slack/setup", "routes/integrations.slack.setup.tsx"),
  route("integrations/slack/events", "routes/integrations.slack.events.tsx"),
  route("integrations/slack/commands", "routes/integrations.slack.commands.tsx"),
  route("integrations/slack/interactions", "routes/integrations.slack.interactions.tsx"),
  route("users/:username", "routes/users.$username.tsx"),
  // /tokens — host-level page listing every active OAuth refresh token
  // bound to the signed-in user (both agent-OAuth-flow tokens and personal
  // API keys minted here). Labelled "Tokens/MCP". The matching JSON endpoint
  // (/api/v1/api-keys.json, kept under its old name for API consumers) mints
  // + lists + revokes keys. /api-keys is a legacy 302-redirect to /tokens.
  route("tokens", "routes/tokens.tsx"),
  route("api-keys", "routes/api-keys.tsx"),
  // The owner's access-request inbox (approve/deny → writes a doco_users
  // grant) + the landing for a just-sent request. Agents request via the
  // doco_request_access MCP tool; humans via the private-doco 403 page.
  route("access-requests", "routes/access-requests.tsx"),
  // Invites: humans accept in the browser; agents authenticate via OAuth and
  // install the hosted MCP connector at /mcp. There is no separate join wizard.
  // decision_01KS14CW9ZN23FF5CGG0Z7TH4G.
  route("invite/:code", "routes/invite.$code.tsx"),
  // Agent-readable companion to /invite/:code. Agents that get pasted
  // an invite URL ("redeem this") fetch this to learn the MCP-OAuth
  // path — the invite URL itself is browser-only.
  route("invite/:code/agent.txt", "routes/invite.$code.agent[.]txt.tsx"),
  // Stable Doco-id links. Handles can change; this resolves the id to
  // the current handle at click/request time and preserves any suffix.
  route("by-id/:docoId", "routes/by-id.$docoId.tsx", { id: "by-id-doco" }),
  route("by-id/:docoId/*", "routes/by-id.$docoId.tsx", { id: "by-id-doco-splat" }),
  // ID-based lookup: the doco_id is immortal across renames and
  // ownership transfers. Agents that record the ULID resolve to the
  // current canonical handle at request time.
  route("api/v1/docos/:docoId.json", "routes/api.v1.docos.$docoId[.]json.tsx"),
  // v15 creation endpoints (decision_01KS3DW9C2KN2X7Z80R18H1RAX).
  // POST-only, auto-suffix on collision, return 201 + the (possibly
  // suffixed) handle.
  route("api/v1/workspaces.json", "routes/api.v1.workspaces[.]json.tsx"),
  route("api/v1/docos.json", "routes/api.v1.docos[.]json.tsx"),
  // Per-user UI preferences (graph auto-reorder, future flags). Stored
  // on users.data.preferences; auth-gated to the signed-in user.
  route("api/v1/me/preferences.json", "routes/api.v1.me.preferences[.]json.tsx"),
  // Agent self-identity: who is this token/session + the access levels on the
  // credential. Powers the post-auth "Authenticated as…" summary that the
  // stdio MCP server renders (agent-identity.server.ts).
  route("api/v1/whoami.json", "routes/api.v1.whoami[.]json.tsx"),
  route("api/v1/feedback-reports.json", "routes/api.v1.feedback-reports[.]json.tsx"),
  // Inbound GitHub App webhook (pull_request events → Reference upserts).
  route("api/github/webhook", "routes/api.github.webhook.tsx"),
  // GitHub App post-install Setup URL callback (click-through connect).
  route("api/github/setup", "routes/api.github.setup.tsx"),
  // Self-chaining PR-import worker (one time-budgeted slice per invocation).
  route("api/github/backfill-run", "routes/api.github.backfill-run.tsx"),
  // Cron sweep: re-kicks "running" backfills whose chain dropped (durability net).
  route("api/github/backfill-sweep", "routes/api.github.backfill-sweep.tsx"),
  // Host-level human-invite + API-key endpoints. Splitting the two
  // makes the "is this a human or an agent?" choice show up in the URL
  // instead of being a body flag.
  route("api/v1/users/invite.json", "routes/api.v1.users.invite[.]json.tsx"),
  route("api/v1/api-keys.json", "routes/api.v1.api-keys[.]json.tsx"),
  // Agent bootstrap. Returns the canonical-instructions prose plus the
  // Doco policies the caller can read. Auth-aware: anonymous callers
  // get public-Doco policies only.
  route("api/v1/agent-bootstrap.json", "routes/api.v1.agent-bootstrap[.]json.tsx"),
  // In-page assistant — the left-rail sidebar visible to every signed-in
  // user. Multiple Señor Doco threads per user; the sidebar header lists
  // them in a dropdown. The agent acts as the signed-in user
  // (cookie-relayed fetches), no separate OAuth identity to authorize.
  // - GET /conversation.json: snapshot of the active thread; pass
  //   ?id=<conv_id> to scope to a specific thread, ?before=<iso> to
  //   paginate older messages.
  // - GET/POST /conversations.json: list user's threads, or mint a new
  //   one (POST body: { title?: string }).
  // - PATCH /conversation/:id.json: rename / archive a thread.
  // - POST /messages.json: send a user message; accepts conversation_id
  //   to target a specific thread, otherwise picks the active one.
  route("api/v1/agent-chat/conversation.json", "routes/api.v1.agent-chat.conversation[.]json.tsx"),
  route(
    "api/v1/agent-chat/conversations.json",
    "routes/api.v1.agent-chat.conversations[.]json.tsx",
  ),
  route(
    "api/v1/agent-chat/conversation/:id.json",
    "routes/api.v1.agent-chat.conversation.$id[.]json.tsx",
  ),
  route("api/v1/agent-chat/messages.json", "routes/api.v1.agent-chat.messages[.]json.tsx"),
  // Attachments — composer uploads files here (POST), then renders
  // previews + sends a GET to /api/v1/agent-chat/attachments/:id for
  // the bytes. 30-day retention enforced by purgeExpiredAttachments().
  route("api/v1/agent-chat/attachments.json", "routes/api.v1.agent-chat.attachments[.]json.tsx"),
  route(
    "api/v1/agent-chat/attachments/:attachmentId",
    "routes/api.v1.agent-chat.attachments.$attachmentId.tsx",
  ),
  // Per-Doco routes: every Doco lives at `/<doco-handle>/...`.
  // `normalizeDocoParams` resolves the public handle-shaped URL
  // param to a row. User profile placeholders live under /users/*
  // so Doco handles remain the root catch-all.
  route(":docoHandle", "routes/$docoHandle._index.tsx"),
  route(":docoHandle/welcome", "routes/$docoHandle.welcome.tsx"),
  route(":docoHandle/status.json", "routes/$docoHandle.status[.]json.tsx"),
  // Live-feed change cursor — the perspective view polls this once a second
  // and only re-runs its heavy loader when the latest audit-event id advances.
  route(":docoHandle/changes.json", "routes/$docoHandle.changes[.]json.tsx"),
  route(":docoHandle/settings", "routes/$docoHandle.settings.tsx"),
  route(":docoHandle/integrations", "routes/$docoHandle.integrations.tsx"),
  // Standalone per-integration detail (GitHub: repos, import status, actions).
  route(":docoHandle/integrations/github", "routes/$docoHandle.integrations.github.tsx"),
  route(":docoHandle/integrations/slack", "routes/$docoHandle.integrations.slack.tsx"),
  route(":docoHandle/policies", "routes/$docoHandle.policies.tsx"),
  route(":docoHandle/policies/new", "routes/$docoHandle.policies.new.tsx"),
  // Stable, linkable page for one policy — agents and humans cite a policy by
  // this URL. The `/new` static segment above out-ranks `:policyId`, so it
  // still wins its match.
  route(":docoHandle/policies/:policyId", "routes/$docoHandle.policies.$policyId.tsx"),
  route(":docoHandle/policies/:policyId/edit", "routes/$docoHandle.policies.$policyId.edit.tsx"),
  route(":docoHandle/invites", "routes/$docoHandle.invites.tsx"),
  route(":docoHandle/api/invites.json", "routes/$docoHandle.api.invites[.]json.tsx"),
  route(":docoHandle/project-tokens", "routes/$docoHandle.project-tokens.tsx"),
  route(":docoHandle/api/project-tokens.json", "routes/$docoHandle.api.project-tokens[.]json.tsx"),
  // Visualization perspectives — tabs above the overview body.
  // Picker page lists builtin + user-owned perspectives; the API
  // route handles attach/detach/set-default form posts. Both must
  // be registered before the catch-all `:docoHandle/:type` below.
  route(":docoHandle/perspectives", "routes/$docoHandle.perspectives._index.tsx"),
  route(":docoHandle/api/perspectives.json", "routes/$docoHandle.api.perspectives[.]json.tsx"),
  // Per-entity detail (PATCH/GET) routes. Most use the makeUpdateRoute
  // factory; decisions.$id has a custom action (ADR promotion logic).
  route(":docoHandle/api/decisions/:id.json", "routes/$docoHandle.api.decisions.$id[.]json.tsx"),
  route(":docoHandle/api/intents/:id.json", "routes/$docoHandle.api.intents.$id[.]json.tsx"),
  route(":docoHandle/api/rules/:id.json", "routes/$docoHandle.api.rules.$id[.]json.tsx"),
  route(":docoHandle/api/policies/:id.json", "routes/$docoHandle.api.policies.$id[.]json.tsx"),
  route(":docoHandle/api/actions/:id.json", "routes/$docoHandle.api.actions.$id[.]json.tsx"),
  route(":docoHandle/api/logs/:id.json", "routes/$docoHandle.api.logs.$id[.]json.tsx"),
  route(":docoHandle/api/evals/:id.json", "routes/$docoHandle.api.evals.$id[.]json.tsx"),
  route(":docoHandle/api/ideas/:id.json", "routes/$docoHandle.api.ideas.$id[.]json.tsx"),
  route(":docoHandle/api/states/:id.json", "routes/$docoHandle.api.states.$id[.]json.tsx"),
  route(":docoHandle/api/references/:id.json", "routes/$docoHandle.api.references.$id[.]json.tsx"),
  // GitHub integration: connect a repo + trigger backfill (writes/reads
  // docos.data.github_integration, consumed by the webhook + backfill).
  route(":docoHandle/api/github.json", "routes/$docoHandle.api.github[.]json.tsx"),
  // Special-cased capture routes that need custom logic — listed BEFORE
  // the generic `:type.json` dispatcher so the static segment wins.
  route(":docoHandle/api/principals.json", "routes/$docoHandle.api.principals[.]json.tsx"),
  route(":docoHandle/api/principals/:id.json", "routes/$docoHandle.api.principals.$id[.]json.tsx"),
  route(":docoHandle/api/settings.json", "routes/$docoHandle.api.settings[.]json.tsx"),
  route(":docoHandle/api/audit.json", "routes/$docoHandle.api.audit[.]json.tsx"),
  route(
    ":docoHandle/api/authoring-contract.json",
    "routes/$docoHandle.api.authoring-contract[.]json.tsx",
  ),
  route(":docoHandle/api/changesets.json", "routes/$docoHandle.api.changesets[.]json.tsx"),

  // First-class edge authoring: create/list + read(+history,
  // ?as_of)/retire. Writes go through the append-only commit() boundary.
  // Registered before the generic :type dispatcher so the static segment wins.
  route(":docoHandle/api/edges.json", "routes/$docoHandle.api.edges[.]json.tsx"),
  route(":docoHandle/api/edges/:id.json", "routes/$docoHandle.api.edges.$id[.]json.tsx"),
  // Policies are not nodes; they live on a
  // dedicated endpoint and are intentionally absent from the generic
  // capture dispatcher below.
  route(":docoHandle/api/policies.json", "routes/$docoHandle.api.policies[.]json.tsx"),
  // Generic capture dispatcher. Handles decisions, intents, ideas, actions,
  // references, rules, logs, evals, states via CAPTURE_REGISTRY in the
  // route file. Adding a new simple-capture entity type is one registry
  // row; no new route needed. Policy types are deliberately not in
  // this registry — see /api/policies.json above.
  route(":docoHandle/api/:type.json", "routes/$docoHandle.api.$type[.]json.tsx"),
  route(":docoHandle/api/:type.txt", "routes/$docoHandle.api.$type[.]txt.tsx"),
  route(":docoHandle/activity", "routes/$docoHandle.activity.tsx"),
  route(":docoHandle/graph-node-details.json", "routes/$docoHandle.graph-node-details[.]json.tsx"),
  route(":docoHandle/graph-edge-details.json", "routes/$docoHandle.graph-edge-details[.]json.tsx"),
  route(":docoHandle/search", "routes/$docoHandle.search.tsx"),
  route(":docoHandle/search.json", "routes/$docoHandle.search[.]json.tsx"),
  route(":docoHandle/rules/new", "routes/$docoHandle.rules.new.tsx"),
  // Edges — Doco's relationships are rows in the `edges`
  // table. The list view is one row per
  // edge; the detail view renders the two connected nodes via
  // EntityGraph plus the edge's metadata. Composite key
  // `(edge_type, from_id, to_id)` is url-encoded as
  // `edge_type__from_id__to_id`.
  route(":docoHandle/edges", "routes/$docoHandle.edges._index.tsx"),
  route(":docoHandle/edges/:edgeKey", "routes/$docoHandle.edges.$edgeKey.tsx"),
  // Short-form entity routes. `:type` is validated by the loader; reserved
  // feature paths above win the match for the static paths.
  route(":docoHandle/:type", "routes/$docoHandle.$type._index.tsx"),
  route(":docoHandle/:type/:id", "routes/$docoHandle.$type.$id.tsx"),
] satisfies RouteConfig;
