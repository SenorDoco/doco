// GET /protocol/agent-oauth-recipe — agent-readable cookbook for
// driving the OAuth flow against Doco WITHOUT an MCP runtime.
//
// Two recipes:
//   A. Localhost loopback (shell-capable agents — Claude Code,
//      Cursor, anything that can bind a TCP port + spawn a browser)
//   B. Device Authorization Grant, RFC 8628 (chat-only agents — no
//      port binding required, no callback URL)
//
// Public; no auth. Served as text/markdown.

import { getPublicBaseUrl } from "@doco/shared";
import { AGENT_INSTRUCTIONS_PATH } from "~/lib/agent-instructions";
import { DOCO_TEMPLATES } from "~/lib/doco-templates-meta";

export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  const templateList = DOCO_TEMPLATES.map(
    (template) => `  - ${template.handle} — ${template.label}: ${template.description}`,
  ).join("\n");
  const body = `# Agent OAuth recipe — get a Doco access token

## Use the hosted MCP connector first (recommended)

The simplest path is the hosted MCP connector — no OAuth code to write.
There is one endpoint; point any MCP-capable client at it. An "all workspaces"
token reaches every workspace you belong to, one doco at a time:

    ${baseUrl}/mcp

It speaks MCP over Streamable HTTP. An unauthenticated request returns
401 + a \`WWW-Authenticate\` header pointing at
\`${baseUrl}/.well-known/oauth-protected-resource/mcp\`
(RFC 9728); a connector client follows that to discover the OAuth server
(RFC 8414) and run the flow for you. Call \`list_workspaces\` / \`doco_whoami\`
to see your reach: all workspaces, specific workspaces, or specific Docos.
The connector is read + write — \`doco_whoami\`, \`list_workspaces\`,
\`doco_brief\`, \`doco_search\`, \`doco_get\`, \`doco_capture\`, \`doco_relate\`,
\`doco_changeset\`, \`doco_policy\`, and \`doco_request_access\` — and read vs write is a live matrix grant on the
same token, never a different login. Setup per client lives in Tokens/MCP:
open ${baseUrl}/tokens and choose the "Add MCP" tab.

When using this hosted MCP connector, auth belongs to the connector
client. Do not ask the user to paste localhost callback URLs back into
chat; if the callback listener fails, restart the client MCP auth flow.

The recipes below are the **fallback** for runtimes that can't speak
remote MCP — they drive the same OAuth flow by hand.

## Driving OAuth by hand (no MCP runtime)

You're an AI agent and you need to read or write a private Doco. You
don't have an MCP runtime that handles auth for you. Pick one of the
two patterns below, depending on your capabilities.

If the Doco is **public**, you don't need any of this — just fetch
\`${baseUrl}/<doco-handle>/\` and friends anonymously.

## Shared prerequisites

Both recipes start the same way. **Do this once per agent install.**

### Reuse same-checkout credentials first

If you are running inside a Doco-tracked repository, check the
repository root \`.env\` before starting OAuth. Agents in the **same
local checkout** share that file:

- Read \`DOCO_ACCESS\`, \`DOCO_REFRESH\`, \`DOCO_CLIENT_ID\`, and
  \`DOCO_HOST\` from repo-root \`.env\`.
- If \`DOCO_ACCESS\` works, use it. Do not ask the user to approve
  another device/browser authorization just because this agent process
  did not start with the token.
- If OAuth succeeds, write the returned tokens back to the same
  repo-root \`.env\` with private permissions. Long-running agents
  should reread \`.env\` before Doco calls because another local agent
  may have refreshed or created the credential.
- Prefer repo-root \`.env\` over stale inherited environment
  variables.

This sharing is intentionally local to one checkout. Separate clones,
worktrees, machines, and remote sandboxes need their own local
\`.env\`; never commit \`.env\`, access tokens, refresh tokens, OAuth
client state, or cookies.

### Register an OAuth client

\`\`\`
POST ${baseUrl}/oauth/register
Content-Type: application/json

{
  "client_name": "<your-agent's display-name, shown to the user>",
  "redirect_uris": ["http://localhost:53682/callback"]
}
\`\`\`

Response:

\`\`\`
{
  "client_id": "doco_client_<base64url-32bytes>",
  "client_name": "...",
  "redirect_uris": [...],
  "registered_at": "..."
}
\`\`\`

Keep \`client_id\` somewhere persistent, preferably repo-root \`.env\`
as \`DOCO_CLIENT_ID\` when you are inside a Doco-tracked repo. You'll
reuse it across all future auth flows for the same local checkout.

If you don't plan to use the localhost-loopback recipe (you're going
to use Device Flow only), you can register with any redirect_uri —
it won't be used. Doco's redirect_uri validator accepts
\`http://localhost:<port>/...\`, \`http://127.0.0.1:<port>/...\`, and
\`https://...\` URLs.

### Repo sharing rule: commit the non-secret Doco files

OAuth tokens are per-agent secrets. The fact that this repository is
connected to a Doco is not secret. After you connect a repo, make sure
the non-secret bootstrap files are committed and pushed so agents
working from another clone know to connect to Doco too.

This rule applies even when you were already authorized before this
session started. A valid \`DOCO_ACCESS\` proves only that your local
runtime can talk to Doco; it does not prove that future agents cloning
the repo will know Doco exists.

Before declaring setup done, check for the bootstrap files:

\`\`\`sh
test -f .doco/connections.md
test -f AGENTS.md
test -f CLAUDE.md
\`\`\`

If any are missing, add them: create \`.doco/connections.md\` with the
public Doco URL, create \`AGENTS.md\` with the instructions at ${baseUrl}${AGENT_INSTRUCTIONS_PATH}, and create \`CLAUDE.md\` as a one-line shim:

\`\`\`
@./AGENTS.md
\`\`\`

Commit these when they exist or changed:

- \`.doco/connections.md\` — public Doco URL(s) for this repo.
- \`AGENTS.md\` and \`CLAUDE.md\` — bootstrap pointers.
- \`.agents/doco-agent-client.mjs\` — helper that reads credentials
  inside Node.
- \`.claude/settings.json\` and \`.claude/*.sh\` — Claude Code hooks,
  when this repo uses them.

Never commit \`.env\`, \`DOCO_ACCESS\`, refresh tokens, OAuth client
state, browser cookies, or any other credential.

If the worktree also contains unrelated user changes, stage only the
Doco bootstrap files you touched:

\`\`\`sh
git status --short
git add .doco/connections.md AGENTS.md CLAUDE.md .agents/doco-agent-client.mjs .claude
git diff --cached --stat
git commit -m "Connect repository to Doco"
git push
\`\`\`

If there is no Git remote or the user asks you not to push, stop after
explaining exactly which non-secret files should be committed.

---

## Recipe A — Localhost loopback (shell-capable agents)

Use this when you can spawn a subprocess that binds a TCP port and
\`open <url>\` (or \`xdg-open <url>\`) a browser. Claude Code, Cursor,
Codex CLI, and any tool-using agent with a shell can do this.

### 1. Generate PKCE pair

\`\`\`
code_verifier  = random ASCII string, 43–128 chars (RFC 7636)
code_challenge = base64url(SHA256(code_verifier))   // no padding
\`\`\`

Keep \`code_verifier\` in memory — never send it to the server until
you exchange the code.

### 2. Bind a local listener

Pick a port (typically 53682 or any free port above 1024). Bind a
minimal HTTP server on \`http://localhost:<port>/callback\`. It needs
to do exactly one thing: capture \`?code=...&state=...\` and shut down.

### 3. Open the authorize URL

Construct:

\`\`\`
${baseUrl}/oauth/authorize
  ?response_type=code
  &client_id=<your-client-id>
  &redirect_uri=http://localhost:<port>/callback
  &code_challenge=<the-S256-challenge>
  &code_challenge_method=S256
  &state=<random>
  &scope=doco
  &target_doco_handle=<doco-handle>    # optional but recommended
  &requested_role=writer                # optional; reader|writer|owner
\`\`\`

**Targeted grants (recommended).** If you already know which Doco
you need — typically read from \`.doco/connections.md\` in the project root,
which carries a URL like \`${baseUrl}/<handle>/\` — pass
\`target_doco_handle\` and \`requested_role\` so the approve screen
focuses on that one Doco with the role pre-filled. Without them
the user sees their full owned-Docos picker.

Open it in the user's browser via \`open\` (macOS) / \`xdg-open\`
(Linux) / \`start\` (Windows) / equivalent. Tell the user what's
happening: "Doco access is being requested — sign in
and pick which Docos to grant."

### 4. Wait for the callback

The user signs in (if not already), sees the approve
screen, picks Docos, clicks Approve. Browser redirects to
\`http://localhost:<port>/callback?code=<doco_code_...>&state=...\`.

Verify the \`state\` matches what you sent. Capture the \`code\`.

### 5. Exchange the code for tokens

\`\`\`
POST ${baseUrl}/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<the-code-you-got>
&client_id=<your-client-id>
&redirect_uri=http://localhost:<port>/callback
&code_verifier=<your-pkce-verifier>
\`\`\`

Response:

\`\`\`
{
  "access_token":  "doco_at_...",
  "refresh_token": "doco_rt_...",
  "token_type":    "Bearer",
  "expires_in":    3600,
  "scope":         "doco"
}
\`\`\`

Store both tokens in your credential store. In a Doco-tracked repo,
write them to repo-root \`.env\` as \`DOCO_ACCESS\` and
\`DOCO_REFRESH\` so every agent in this same checkout can reuse them.
Then follow the repo sharing rule above: commit and push the
non-secret Doco bootstrap files so the next agent clone discovers the
Doco connection and can create its own local credential.

---

## Recipe B — Device Authorization Grant (chat-only agents)

Use this when you **can't** bind a port (you're in a sandboxed runtime,
you're a chat-only agent, you're running remotely from the user's
browser, …). Standard RFC 8628 flow.

### 1. Start the device authorization

\`\`\`
POST ${baseUrl}/oauth/device_authorization
Content-Type: application/x-www-form-urlencoded

client_id=<your-client-id>
&scope=doco
&target_doco_handle=<doco-handle>      # optional but recommended
&requested_role=writer                  # optional; reader|writer|owner
\`\`\`

**Targeted grants (recommended).** If you already know which Doco you
need — typically read from \`.doco/connections.md\` in the project root, which
carries a URL like \`${baseUrl}/<handle>/\` — pass the handle as
\`target_doco_handle\` and your desired role as \`requested_role\`. The
approve screen then focuses on that one Doco with your requested
role pre-filled, instead of showing the user the full picker. The
user can still adjust the role before approving, but they're not
forced to scroll through every Doco they own to find the right one.

Both params are optional; omit them and the user sees their full
owned-Docos picker (still works, just a worse UX when you know
exactly what you need).

Response:

\`\`\`
{
  "device_code":               "doco_dc_<base64url-32bytes>",
  "user_code":                 "WXYZ-1234",
  "verification_uri":          "${baseUrl}/device",
  "verification_uri_complete": "${baseUrl}/device?user_code=WXYZ-1234",
  "expires_in":                900,
  "interval":                  5
}
\`\`\`

### 2. Show the code to the user

Tell them clearly:

> Open ${baseUrl}/device in your browser and enter the code: WXYZ-1234
>
> (or, faster: open ${baseUrl}/device?user_code=WXYZ-1234)
>
> Then sign in and pick which Docos to grant.

The \`verification_uri_complete\` saves them typing — use it.

### 3. Poll for the token

Every \`interval\` seconds (default 5), call:

\`\`\`
POST ${baseUrl}/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:device_code
&device_code=<the-device-code-from-step-1>
&client_id=<your-client-id>
\`\`\`

Possible responses:

- **400** \`{"error": "authorization_pending"}\` — user hasn't approved
  yet. Wait \`interval\` seconds, poll again. Keep going until you get
  a different response.
- **400** \`{"error": "slow_down"}\` — you're polling too fast.
  Increase \`interval\` by 5 seconds, then continue.
- **400** \`{"error": "access_denied"}\` — user clicked Deny. Stop
  polling; tell the user the request was denied.
- **400** \`{"error": "expired_token"}\` — the device_code expired
  (15 min). Start over from step 1.
- **200** \`{ access_token, refresh_token, token_type, expires_in, scope }\`
  — user approved. Store the tokens in the repo-root \`.env\` when
  you are inside a Doco-tracked repo, then follow the repo sharing
  rule above: commit and push the non-secret Doco bootstrap files so
  the next agent clone discovers the Doco connection and can create
  its own local credential.

---

## Using the access token

Once you have an access_token (either recipe), attach it to every
authenticated request:

\`\`\`
Authorization: Bearer doco_at_<your-access-token>
\`\`\`

### First call after auth — fetch the bootstrap manifest

Before anything else, hit the bootstrap endpoint. Don't guess this
URL; it's exactly:

\`\`\`
GET ${baseUrl}/api/v1/agent-bootstrap.json
Authorization: Bearer doco_at_<your-access-token>
\`\`\`

You get back:

- \`principal\` — your authenticated identity (\`id\` + \`username\`).
  Confirms the token works and tells you who you're acting as.
- \`agent_instructions\` — the instructions you're now expected to
  follow, the same block ${AGENT_INSTRUCTIONS_PATH} shows.
- \`agent_instructions_url\` — that page, to refetch them later.
- \`oauth_grant\` — your token's grant set verbatim:
  \`granted_doco_ids\`, \`granted_workspace_ids\`, \`granted_doco_roles\`,
  \`granted_workspace_roles\`, \`scope\`, \`expires_at\`. Null for cookie
  callers. Read this to know exactly which Docos and workspaces your token
  covers without inferring from the policies lists.
- \`doco_policies[]\` — Policies for every Doco your grants
  cover.

The policies tell you what's expected when you capture or
modify nodes in each Doco. Cache the response for the session;
refetch if the user tells you policies changed mid-session.

### Workspace grants are live — don't ask for re-auth on new Docos

If your token's \`granted_workspace_ids\` includes an workspace, that grant
**automatically covers every Doco the workspace owns, including ones the
user creates after the token was minted**. You do not need to
re-run the OAuth flow when a new Doco appears under an already-
granted workspace — the same Bearer token works on it immediately.
An "all workspaces" token goes one level up: it reaches every Workspace the
user belongs to, including Workspaces they create after the token was
minted, so a brand-new project is reachable the moment the user creates
its Workspace.

Concretely: if a user asks you to work on a project whose workspace
lacks the Doco the work needs, and your token holds that workspace as
owner (\`oauth_grant.granted_workspace_ids\`, or an "all workspaces"
token), create the Doco yourself: \`doco_create\` over MCP, or
\`POST /api/v1/docos.json\` (see "Start a project" below). The
existing token reaches the new Doco as soon as it exists — no
re-authorization needed.

The *wrong* moves are to send the user to the website to create it,
to tell the user to grant your token again via the consent UI, or to
re-run your install's OAuth helper script. All of them waste the
user's time.

### Be precise about your role — don't downgrade yourself in prose

When you describe your grants to the user, surface the **role cap**
from \`oauth_grant.granted_workspace_roles[workspace_id]\` (or
\`granted_doco_roles[doco_id]\`) — not a generic "readable: X"
phrasing. The role table:

  - \`reader\` — list + read nodes
  - \`writer\` — capture, patch, retire, and change a node's
    \`lifecycle\` (drafting → queued → active → retired) (+ everything reader
    can do). What a writer may or may not do is governed by the Doco's
    own policies, not a built-in role ladder.
  - \`owner\` — Doco settings, invites, role changes, granting agent
    access, editing policies (+ everything writer + reader can do)

Saying "Workspaces readable: doco, torrenegra" when you actually hold
\`writer\` on both is misleading — the user can't tell how much
work you're authorized to do without re-checking. Prefer:

> "Workspaces in reach: doco (writer), torrenegra (writer)"
> "Docos in reach: doco-bpms (writer, via doco-workspace grant)"

If the user asks "what can you do?", read out the role from
\`oauth_grant\` for each grant — don't collapse to the lowest
operation you happen to be planning right now.

### Endpoint shapes

Doco's HTTP API splits cleanly between page-level routes (under the
Doco's root) and JSON API routes (under \`/api/\`). Pages stay HTML;
JSON lives at \`/api/\`. The single exception is \`/status.json\` at
the root, kept for backwards compat.

**Doco root:**

\`\`\`
GET ${baseUrl}/<handle>/                          # HTML home; no JSON form
GET ${baseUrl}/<handle>/status.json               # counts + freshness (root, not /api/)
\`\`\`

**Start a project.** One project = one Workspace; its Docos are the
kinds of knowledge inside it (decisions, ideas, bugs, …). Find the
project's Workspace first (\`GET ${baseUrl}/api/v1/workspaces.json\`).
If none matches, ask the user to create one at ${baseUrl}/new-workspace
— agents never create Workspaces, and the API has no create call for
them (a POST to the workspaces endpoint answers 405). Your access to it
comes from your grant: all of the user's Workspaces (an "all workspaces"
token, which reaches Workspaces created after it was minted), one
Workspace, or a subset of its Docos. Then create the project's Docos
inside it:

\`\`\`
POST ${baseUrl}/api/v1/docos.json
Content-Type: application/json
Authorization: Bearer doco_at_<your-access-token>

{
  "workspace_id": "<id from the workspaces list>",
  "name": "acme-decisions",
  "template_handle": "architectural-decisions"
}
\`\`\`

\`template_handle\` is one of:

${templateList}

**List + capture per node type** — types are \`decisions\`,
\`rules\`, \`intents\`, \`actions\`, \`logs\`, \`evals\`, \`references\`,
\`states\`, \`principals\`, \`invites\`, \`audit\`:

\`\`\`
GET  ${baseUrl}/<handle>/api/<type>.json          # list nodes of that type
POST ${baseUrl}/<handle>/api/<type>.json          # capture a new one
\`\`\`

**Read + patch one node:**

\`\`\`
GET   ${baseUrl}/<handle>/api/<type>/<id>.json    # fetch a single node
PATCH ${baseUrl}/<handle>/api/<type>/<id>.json    # update fields
\`\`\`

**Per-type write spec** (request-body shape for POST/PATCH):

\`\`\`
GET ${baseUrl}/<handle>/api/<type>.txt            # plain-text spec for capture-capable node types
\`\`\`

Capture body specs exist for decisions, intents, actions, logs, rules,
evals, references, states, ideas, policies, settings, and principals.
Principals expose a smaller surface (create + retire only) — read the
\`principals.txt\` spec rather than assuming the generic capture body.
Invites and audit have dedicated route behavior; don't infer write
bodies for them from the generic capture pattern.

**Capture body convention:** node request bodies store prose and scalar
attributes only. Relationships to principals and other nodes are
first-class edges created with \`POST /<handle>/api/edges.json\` or
\`POST /<handle>/api/changesets.json\`.

Common principal relationship roles on attributed_to/has_parent edges:

\`\`\`
owned_by          # Intent/Rule/Eval owner or author Principal
performed_by      # Action/Log performer Principal
decided_by        # Decision maker Principal
has_stakeholder   # Intent stakeholder Principal
reports_to        # Principal manager Principal
\`\`\`

\`created_by\` is user/API-key provenance derived from the
authenticated session or token. Never send \`created_by\` in POST/PATCH
bodies.

### Scope enforcement

The token carries **two** grant lists with per-entry role caps:

  - \`granted_doco_ids[]\` + \`granted_doco_roles{doco_id: role}\` —
    explicit per-Doco grants.
  - \`granted_workspace_ids[]\` + \`granted_workspace_roles{workspace_id: role}\` —
    workspace-level grants. These are **live**: they cover every Doco the
    workspace owns now AND any Doco created under the workspace after the token
    was minted, with no re-auth required.

A request to a Doco is allowed if the Doco's id is in
\`granted_doco_ids\` OR the Doco's owner workspace is in
\`granted_workspace_ids\`, AND the corresponding role cap meets what the
operation requires. Outside that set you get 403 \`access_denied\`;
inside the set but with insufficient role you get 403
\`insufficient_scope\` plus \`WWW-Authenticate: Bearer
error="insufficient_scope"\`. The operation→role table:

  - List + read GETs require \`reader\`
  - Capture, patch, retire, and any \`lifecycle\` change require
    \`writer\`
  - Admin (Doco settings, invites, role changes, granting agent
    access, editing policies) requires \`owner\`

## Hook tokens: read-only, as the person, no OAuth

OAuth tokens expire and live inside the agent's client, out of a
hook's reach. A hook token is a read-only credential that reads
one workspace as the member who made it: the Docos they can read
there, checked on every request, so it loses what they lose. The
Doco hook reads it from \`.doco/hook-tokens.json\` or
\`DOCO_TOKEN\`.

### Get the hook's token

Call the MCP tool \`doco_hook_token\` with the workspace's handle. It
returns the person's token for the hook in that workspace, made the
first time and the same one after, with where to save it. A fresh
clone or container calls it again and gets the same token back.

### Or mint one

Any member, at \`${baseUrl}/workspaces/<workspace-handle>/hook-tokens\`
or through the API:

\`\`\`
POST ${baseUrl}/api/v1/workspaces/<workspace-handle>/hook-tokens.json
Authorization: Bearer doco_at_<member's-oauth-token>
Content-Type: application/json

{ "label": "optional label" }
\`\`\`

Response (the token body is shown this once):

\`\`\`
{
  "token":   "doco_ht_<base64url-32-bytes>",
  "summary": { ... metadata, no token body ... },
  "install_hint": "<markdown: where to save the token and turn on the hook>"
}
\`\`\`

### Save it, out of git

Save the token at \`.doco/hook-tokens.json\` in the repo root and
add that file to \`.gitignore\`: whoever holds it reads as the person.

\`\`\`json
{
  "<workspace-handle>": "doco_ht_<token>"
}
\`\`\`

### Use it

\`\`\`
GET ${baseUrl}/api/v1/brief.json?about=<what you are about to do>
Authorization: Bearer doco_ht_<token>
\`\`\`

The token is fixed at **reader** role. Writes (POST/PATCH/DELETE)
fail with HTTP 403 \`insufficient_scope\`. The bootstrap
(\`GET /api/v1/agent-bootstrap.json\`) returns the workspace's
constitution and the policies of the Docos the person can read, with
\`principal: null\` and a
\`hook_token_grant: { workspace_id, role: "reader" }\` marker so
agents know which path they're on.

### Revoke

Same page or:

\`\`\`
DELETE ${baseUrl}/api/v1/workspaces/<workspace-handle>/hook-tokens.json?id=<8-char-suffix>
Authorization: Bearer doco_at_<member's-oauth-token>
\`\`\`

A member revokes their own tokens; an owner revokes anyone's.
Revoking takes effect immediately.

### Don't conflate hook tokens with OAuth

\`doco_ht_…\` and \`doco_at_…\` are different credentials. Hook
tokens have no refresh, no expiry and no write scope. If your runtime
needs to capture nodes or edit the Doco, OAuth is still the path —
hook tokens cannot widen.

## Refreshing

Access tokens last 24 hours. When you get a 401, refresh:

\`\`\`
POST ${baseUrl}/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<your-refresh-token>
&client_id=<your-client-id>
\`\`\`

Returns a new \`{access_token, refresh_token, ...}\` pair. The old
refresh_token is now revoked — store the new one immediately.

## Revoking

\`\`\`
POST ${baseUrl}/oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=<access-or-refresh-token>
&client_id=<your-client-id>
\`\`\`

Idempotent. Use this when you no longer need the tokens (user said
"forget the Doco", agent process is shutting down, etc.).

## Discovery doc

The machine-readable advertisement of these endpoints
lives at \`${baseUrl}/.well-known/oauth-authorization-server\` per RFC
8414. Fetch it if you want to pick the endpoints up dynamically
instead of hard-coding them.
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}
