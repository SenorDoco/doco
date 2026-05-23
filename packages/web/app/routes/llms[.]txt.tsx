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
  GET  ${baseUrl}/<handle>/api/<type>.json          # list neurons of that type
  POST ${baseUrl}/<handle>/api/<type>.json          # capture a new one (need 'author' role)
  GET  ${baseUrl}/<handle>/api/<type>/<id>.json     # fetch one neuron
  PATCH ${baseUrl}/<handle>/api/<type>/<id>.json    # update fields (need 'author' role)
  GET  ${baseUrl}/<handle>/api/<type>.txt           # plain-text spec for capture-capable body shapes
  GET  ${baseUrl}/<handle>/api/primitives.json      # list primitives (NOT neurons)
  POST ${baseUrl}/<handle>/api/primitives.json      # capture a primitive
  POST ${baseUrl}/api/v1/docos.json                 # create a Doco in one request

Neuron types: \`decisions\`, \`ideas\`, \`rules\`, \`intents\`,
\`actions\`, \`logs\`, \`evals\`, \`references\`, \`states\`,
\`principals\`, \`invites\`, \`audit\`.

Capture body specs exist for decisions, intents, actions, logs, rules,
evals, references, states, ideas, primitives, and settings. Principals,
invites, and audit have dedicated route behavior; don't infer write
bodies for them from the generic capture pattern.

Primitives are not neurons. Primitives (guidance + neuron-authoring)
live on \`/api/primitives.json\`. The generic \`/api/<type>.json\` route
refuses primitive types.

Before POST/PATCH, read \`GET /<handle>/api/<type>.txt\` for the
exact request body when that spec exists. Principal references in
request bodies use principal ids only: \`*_principal_id\` for one
principal and \`*_principal_ids\` for arrays. Do not send usernames,
\`*_username\` fields, or comma-separated strings; there are no
compatibility aliases.

Common API-facing principal fields:

    wanted_by_principal_id        # Intent owner; auth fills this
    actors_principal_ids          # Intent actors, array of principal ids
    stakeholders_principal_ids    # Intent stakeholders, array of principal ids
    actor_principal_id            # Action/Log actor; auth fills this
    decided_by_principal_id       # Decision maker; auth fills this
    authored_by_principal_id      # Rule/Eval/Primitive author; auth fills this
    created_by_principal_id       # Creator override where supported

Read responses may expose stored graph fields such as \`wanted_by\`,
\`actors\`, \`stakeholders\`, \`actor_id\`, \`decided_by\`, and
\`created_by\`. Those are storage field names; request bodies should
use the API-facing principal-id fields above.

Create a Doco with:

    POST ${baseUrl}/api/v1/docos.json
    Content-Type: application/json
    Authorization: Bearer doco_at_<token>

    {
      "template_handle": "generic",
      "org_id": "<organization-id>",
      "name": "bpms",
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

You'll get the canonical instructions plus the union of every **org**
and **Doco primitives set** you have read-or-above access to. Org
primitives apply to every Doco the org owns, so an agent that
bootstraps Doco (the tool) sees the full set of authoring rules
governing its work across every project it can reach.

## Related routes

    ${baseUrl}/sign-in
    ${baseUrl}/new-doco
    ${baseUrl}/.well-known/oauth-authorization-server
    ${baseUrl}/protocol/canonical-instructions
    ${baseUrl}/protocol/agent-oauth-recipe
    ${baseUrl}/api/v1/agent-bootstrap.json
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
