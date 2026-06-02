// /llms.txt — agent-readable entry point at the host root.
//
// Convention: https://llmstxt.org/. Served as text/plain.
import { getPublicBaseUrl } from "@doco/shared";

export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  const body = `# Doco

> Doco is AI-native documentation of intents, decisions, rules, and
> actions for software projects. Every meaningful change leaves a
> trail; every contributor working in a Doco-tracked project follows
> a shared protocol.

If a user just told you something like "let's start using Doco" or
"visit doco.to and follow the wizard", you're at the right page.

## Connect via the hosted MCP server (easiest)

Doco hosts a remote MCP server PER WORKSPACE — there is no app-wide MCP.
Each workspace has its own endpoint, and a connector's token is bound to
that ONE workspace; it can reach no other:

    ${baseUrl}/<workspace-id>/mcp

A workspace id looks like \`workspace_01…\`. Your project owner finds it on
the workspace's Settings page (or the Tokens/MCP page under "Add MCP
manually"). Substitute it for \`<workspace-id>\` below.

It speaks MCP over Streamable HTTP (JSON-RPC 2.0), gated by the same
OAuth 2.1 server described below. An unauthenticated request gets a 401
with a \`WWW-Authenticate\` header pointing at
\`${baseUrl}/.well-known/oauth-protected-resource/<workspace-id>/mcp\`
(RFC 9728); a connector client follows that to discover the authorization
server (RFC 8414) and run the flow — no repo, no local files.

Per client:

  - claude.ai / Claude mobile / Cursor: add a custom connector with the
    URL ${baseUrl}/<workspace-id>/mcp — the client runs OAuth for you.
  - Claude Desktop / Claude Code (no native remote MCP yet): bridge with
    \`npx mcp-remote ${baseUrl}/<workspace-id>/mcp\`.
  - ChatGPT and other MCP clients: add the same URL as a connector.

Tools available now: \`doco_whoami\` (identity + the Docos you can reach in
this workspace), \`doco_search\` + \`doco_get\` (read), \`doco_capture\`,
\`doco_relate\` + \`doco_changeset\` (write), and \`doco_request_access\` (ask an
owner for a grant). Every tool operates only on Docos inside this one
workspace; doco_whoami lists them, so find a project's Doco there rather
than guessing the handle. Read vs write is a live grant on the same token,
so stepping up read→write never needs a re-auth — request it and an owner
approves. There are no auth tools here — the bearer token is the auth.

A token is scoped to a single workspace at most: to work across several
workspaces, add one connector per workspace. Remote MCP auth is the
connector client's job. Do not ask the user to paste localhost callback
URLs back into chat; if the callback listener fails, restart the client MCP
auth flow. Use the direct OAuth recipes below only when you are not
connecting through a workspace MCP endpoint.

If your client cannot speak remote MCP at all, drive the OAuth recipes
below directly.

## Agent auth in one sentence

Doco runs a standard OAuth 2.1 authorization server (RFC 8414 +
PKCE S256 + dynamic client registration). Doco-tracked repos may ship
an MCP helper that automates the same flow; if MCP is unavailable,
YOU (the agent) drive the OAuth dance directly. Pick one of two
recipes depending on your runtime, both documented step by step at:

    ${baseUrl}/protocol/agent-oauth-recipe

## Quick recipe picker

**Are you a shell-capable agent (Claude Code, Cursor, anything that
can bind a TCP port and \`open\` a browser)?**
  → Recipe A: localhost-loopback OAuth. PKCE + authorize URL + a
    tiny local listener catches the callback. Familiar pattern —
    same as \`gh auth login\`.

**Are you a chat-only or sandboxed agent (no port binding, no
process spawning)?**
  → Recipe B: Device Authorization Grant (RFC 8628). You show the
    user a short code like \`WXYZ-1234\`, they enter it at
    ${baseUrl}/device, and you poll \`${baseUrl}/oauth/token\` until they
    approve.

Both recipes give you back a \`doco_at_…\` Bearer token. After that,
every API call is:

    GET ${baseUrl}/<handle>/<endpoint>
    Authorization: Bearer doco_at_<token>

## Avoid repeated authorization in one local repo

If you are running inside a Doco-tracked repository, first check the
repository root \`.env\`. Agents in the same local checkout share
\`DOCO_ACCESS\`, \`DOCO_REFRESH\`, \`DOCO_CLIENT_ID\`, and \`DOCO_HOST\`
through that file.

If \`DOCO_ACCESS\` from repo-root \`.env\` works, reuse it and do not
ask the user to approve another authorization flow. When OAuth
succeeds, write the returned tokens back to that same \`.env\` so the
next agent in this checkout can reuse them. Long-running agents should
reread \`.env\` before Doco calls because another same-checkout agent
may have authorized or refreshed credentials after this process
started.

This sharing is local and secret. Never commit \`.env\` or token
values. Separate clones, worktrees, machines, and remote sandboxes
need their own local \`.env\`; the committed bootstrap files below
only tell them which Doco to connect to.

## Share the Doco connection through Git

Tokens are per-agent secrets; repository connection files are not.
When you connect a repo to Doco, or when you discover you already have
valid Doco auth in an unbootstrapped repo, verify the bootstrap files
exist:

    test -f .doco/connections.md
    test -f AGENTS.md
    test -f CLAUDE.md

If any are missing, add them before you declare setup done. With the
CLI installed, run \`doco install-agent-bootstrap\`; otherwise create
\`.doco/connections.md\` with the public Doco URL, \`AGENTS.md\` with
the Doco connection/OAuth instructions, and \`CLAUDE.md\` as
\`@./AGENTS.md\`.

Then commit and push the non-secret files that let other agents
discover the same Doco:

    git status --short
    git add .doco/connections.md AGENTS.md CLAUDE.md .agents/doco-agent-client.mjs .claude
    git diff --cached --stat
    git commit -m "Connect repository to Doco"
    git push

Never stage or commit \`.env\`, \`DOCO_ACCESS\`, refresh tokens,
OAuth client state, cookies, or any other credential. If the worktree
has unrelated changes, stage only the Doco bootstrap files you touched.

## API endpoint shapes

JSON lives under \`/api/\`. HTML pages live at the Doco root (no
\`/api/\` prefix). One exception: \`/status.json\` lives at the root
for backwards compat.

  GET  ${baseUrl}/<handle>/status.json              # counts + freshness
  GET  ${baseUrl}/<handle>/api/<type>.json          # list nodes of that type
  POST ${baseUrl}/<handle>/api/<type>.json          # capture a new one (need 'writer' role)
  GET  ${baseUrl}/<handle>/api/<type>/<id>.json     # fetch one node
  PATCH ${baseUrl}/<handle>/api/<type>/<id>.json    # update fields (need 'writer' role)
  GET  ${baseUrl}/<handle>/api/<type>.txt           # plain-text spec for capture-capable body shapes
  GET  ${baseUrl}/<handle>/api/policies.json      # list policies (NOT nodes)
  POST ${baseUrl}/<handle>/api/policies.json      # capture a policy
  POST ${baseUrl}/api/v1/docos.json                 # create a Doco in one request

Node types: \`decisions\`, \`ideas\`, \`rules\`, \`intents\`,
\`actions\`, \`logs\`, \`evals\`, \`references\`, \`states\`,
\`principals\`, \`invites\`, \`audit\`.

Capture body specs exist for decisions, intents, actions, logs, rules,
evals, references, states, ideas, policies, settings, and principals.
Principals expose a smaller surface (create + retire only) — read the
\`principals.txt\` spec rather than assuming the generic capture body.
Invites and audit have dedicated route behavior; don't infer write
bodies for them from the generic capture pattern.

Policies are not nodes. Policies (guidance + node-authoring)
live on \`/api/policies.json\`. The generic \`/api/<type>.json\` route
refuses policy types.

Before POST/PATCH, read \`GET /<handle>/api/<type>.txt\` for the
exact request body when that spec exists. Node capture bodies store
prose and scalar attributes only. Relationships to principals and other
nodes are first-class edges created with \`POST /<handle>/api/edges.json\`
or \`POST /<handle>/api/changesets.json\` (\`relate\` /
\`relate_many\`).

Common principal relationship roles on attributed_to/has_parent edges:

    owned_by          # Intent/Rule/Eval owner or author Principal
    performed_by      # Action/Log performer Principal
    decided_by        # Decision maker Principal
    has_stakeholder   # Intent stakeholder Principal
    reports_to        # Principal manager Principal

\`created_by\` is user/API-key provenance derived from the
authenticated session or token. Never send \`created_by\` in request
bodies.

Create a Doco with:

    POST ${baseUrl}/api/v1/docos.json
    Content-Type: application/json
    Authorization: Bearer doco_at_<token>

    {
      "template_handle": "generic",
      "workspace_id": "<workspace-id>",
      "name": "acme-bpms",
      "privacy": "private"
    }

## Public Doco reads (no auth)

Public Docos accept anonymous reads. If your project owner tells you
the Doco is public, skip OAuth entirely and use the same endpoints
above without an Authorization header. They return 200 for public
Docos and 403 for private ones.

## Invite URLs are human-only

If a project owner pastes you a URL like \`${baseUrl}/invite/<code>\`,
that URL is for a human to open in their browser, sign in, and
accept. Don't try to POST/redeem it from agent code.

If you (the agent) need access, run the OAuth recipe above. The
human approves your access at \`${baseUrl}/device\` (Recipe B) or in
the authorize browser tab (Recipe A).

## Bootstrap manifest

Once you hold a Bearer token, hit:

    GET ${baseUrl}/api/v1/agent-bootstrap.json
    Authorization: Bearer doco_at_<token>

You'll get the canonical instructions plus the union of every **workspace**
and **Doco policies set** you have read-or-above access to. Workspace
policies apply to every Doco the workspace owns, so an agent that
bootstraps Doco (the tool) sees the full set of authoring rules
governing its work across every project it can reach.

## Related routes

    ${baseUrl}/sign-in
    ${baseUrl}/new-doco
    ${baseUrl}/<workspace-id>/mcp
    ${baseUrl}/.well-known/oauth-authorization-server
    ${baseUrl}/.well-known/oauth-protected-resource
    ${baseUrl}/protocol/canonical-instructions
    ${baseUrl}/protocol/agent-oauth-recipe
    ${baseUrl}/api/v1/agent-bootstrap.json
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
