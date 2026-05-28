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

export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request).replace(/\/+$/, "");
  const body = `# Agent OAuth recipe — get a Doco access token

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

If any are missing, add them. If \`doco-cli\` is installed, the easiest
path is:

\`\`\`sh
doco install-agent-bootstrap
\`\`\`

Otherwise create \`.doco/connections.md\` with the public Doco URL,
create \`AGENTS.md\` with the Doco connection/OAuth instructions, and
create \`CLAUDE.md\` as a one-line shim:

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
  &requested_role=author                # optional; reader|author|approver|owner
\`\`\`

**Targeted grants (recommended).** If you already know which Doco
you need — typically read from \`.doco/connections.md\` in the project root,
which carries a URL like \`${baseUrl}/<handle>/\` — pass
\`target_doco_handle\` and \`requested_role\` so the approve screen
focuses on that one Doco with the role pre-filled. Without them
the user sees their full owned-Docos picker.

Open it in the user's browser via \`open\` (macOS) / \`xdg-open\`
(Linux) / \`start\` (Windows) / equivalent. Tell the user what's
happening: "I'm asking for access to a Doco — sign in
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
&requested_role=author                  # optional; reader|author|approver|owner
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
- \`canonical_instructions\` — the Doco protocol you're now expected
  to follow.
- \`canonical_instructions_url\` — link to the same instructions in
  case you want to refetch them later.
- \`oauth_grant\` — your token's grant set verbatim:
  \`granted_doco_ids\`, \`granted_org_ids\`, \`granted_doco_roles\`,
  \`granted_org_roles\`, \`scope\`, \`expires_at\`. Null for cookie
  callers. Read this to know exactly which Docos and orgs your token
  covers without inferring from the policies lists.
- \`doco_policies[]\` — Policies for every Doco your grants
  cover.

The policies tell you what's expected when you capture or
modify nodes in each Doco. Cache the response for the session;
refetch if the user tells you policies changed mid-session.

### Org grants are live — don't ask for re-auth on new Docos

If your token's \`granted_org_ids\` includes an org, that grant
**automatically covers every Doco the org owns, including ones the
user creates after the token was minted**. You do not need to
re-run the OAuth flow when a new Doco appears under an already-
granted org — the same Bearer token works on it immediately.

Concretely: if a user asks you to work on a project that has no
Doco yet, and \`oauth_grant.granted_org_ids\` already contains the
org they'd create it under, the right move is:

> "I'll wait while you create the Doco at ${baseUrl} (the form starts
> the name with \`<org-handle>-\`, but you can use any available handle). My existing
> token has org-level access, so the new Doco will be reachable as
> soon as you finish creating it — no re-authorization needed."

The *wrong* move is to tell the user to grant your token again via
the consent UI, or to re-run your install's OAuth helper script.
Both are no-ops here and waste the user's time.

(Creating the Doco itself is a human-only action — see "Things only
people can do" in the canonical instructions. The agent's job is to
recognize that the existing grant suffices and avoid the spurious
re-auth ask.)

### Be precise about your role — don't downgrade yourself in prose

When you describe your grants to the user, surface the **role cap**
from \`oauth_grant.granted_org_roles[org_id]\` (or
\`granted_doco_roles[doco_id]\`) — not the generic "I can read X"
phrasing. The role table:

  - \`reader\` — list + read nodes
  - \`author\` — author can capture + patch nodes (+ everything reader
    can do)
  - \`approver\` — approver can change a node's \`lifecycle\` /
    approve-reject lifecycle transitions (+ author + reader)
  - \`owner\` — Doco settings, invites, role changes, granting agent
    access (+ approver + author + reader)

Saying "Orgs I can read: doco, torrenegra" when you actually hold
\`approver\` on both is misleading — the user can't tell how much
work you're authorized to do without re-checking. Prefer:

> "Orgs I can act on: doco (approver), torrenegra (approver)"
> "Docos I can act on: doco-bpms (approver, via doco-org grant)"

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

**Create a Doco in one request:**

\`\`\`
POST ${baseUrl}/api/v1/docos.json
Content-Type: application/json
Authorization: Bearer doco_at_<your-access-token>

{
  "template_handle": "generic",
  "org_id": "<organization-id>",
  "name": "acme-bpms",
  "privacy": "private"
}
\`\`\`

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

**Capture body convention:** request bodies identify principals by
principal id, never by name. Use \`*_principal_id\` for one principal
and \`*_principal_ids\` for arrays. Do not send \`*_name\` fields
or comma-separated strings; there are no aliases.

Common API-facing fields:

\`\`\`
wanted_by_principal_id        # Intent owner; auth fills this
actors_principal_ids          # Intent actors, array of principal ids
stakeholders_principal_ids    # Intent stakeholders, array of principal ids
actor_principal_id            # Action/Log actor; auth fills this
decided_by_principal_id       # Decision maker; auth fills this
authored_by_principal_id      # Rule/Eval/Policy author; auth fills this
\`\`\`

Read responses may expose stored graph fields such as \`wanted_by\`,
\`actors\`, \`stakeholders\`, \`actor_id\`, and \`decided_by\`.
\`created_by\` is collaborator/API-key provenance derived from the
authenticated session or token. Never send \`created_by\` in POST/PATCH
bodies; use the API-facing principal-id fields above only for domain
actors.

### Scope enforcement

The token carries **two** grant lists with per-entry role caps:

  - \`granted_doco_ids[]\` + \`granted_doco_roles{doco_id: role}\` —
    explicit per-Doco grants.
  - \`granted_org_ids[]\` + \`granted_org_roles{org_id: role}\` —
    org-level grants. These are **live**: they cover every Doco the
    org owns now AND any Doco created under the org after the token
    was minted, with no re-auth required.

A request to a Doco is allowed if the Doco's id is in
\`granted_doco_ids\` OR the Doco's owner org is in
\`granted_org_ids\`, AND the corresponding role cap meets what the
operation requires. Outside that set you get 403 \`access_denied\`;
inside the set but with insufficient role you get 403
\`insufficient_scope\` plus \`WWW-Authenticate: Bearer
error="insufficient_scope"\`. The operation→role table:

  - List + read GETs require \`reader\`
  - Capture + patch require \`author\` (PATCH of \`lifecycle\` is the
    exception — see \`approver\` below)
  - Approving / archiving a node (PATCH that changes \`lifecycle\`)
    requires \`approver\`
  - Admin (Doco settings, invites, role changes, granting agent
    access) requires \`owner\`

## Project tokens — committable, read-only, no OAuth

OAuth tokens are per-user secrets. Some Docos don't need per-user
secrets: when the Doco's contents are OK to be readable by anyone
who can read the repo, the Doco's **owner** can mint a "project
token" and commit it to the repo. Any agent cloning the repo then
reads the Doco without OAuth.

### When to suggest this to the user

After completing OAuth once, mention it as one of two options for
avoiding the auth dance on every fresh container / new clone (the
other is setting \`DOCO_ACCESS\` as a runtime environment variable;
see the canonical instructions). Don't make the choice for the
user — surface both, let them pick.

### Mint flow (Doco owner only, requires explicit confirmation)

1. Open \`${baseUrl}/<handle>/project-tokens\`.
2. Check the "I understand that anyone with read access to a repo
   where this token is committed will be able to read this Doco"
   box. The mint button stays disabled until you do.
3. Click "Mint project token". The full token body is shown
   **once** — copy it now. The page never displays the body again.

The API equivalent:

\`\`\`
POST ${baseUrl}/<handle>/api/project-tokens.json
Authorization: Bearer doco_at_<owner's-oauth-token>
Content-Type: application/json

{ "confirm_repo_readable": true, "label": "optional label" }
\`\`\`

Response:

\`\`\`
{
  "token":   "doco_pt_<base64url-32-bytes>",
  "summary": { ... metadata, no token body ... },
  "install_hint": "<markdown for the user>"
}
\`\`\`

### Commit it

Save the token at \`.doco/project-tokens.json\` in the repo root:

\`\`\`json
{
  "<doco-handle>": "doco_pt_<token>"
}
\`\`\`

Commit and push. Any agent that clones the repo and runs the
bundled MCP server (\`.agents/doco-mcp-server.mjs\`) will use this
token automatically when no \`DOCO_ACCESS\` is set in \`.env\`.

### Use it

\`\`\`
GET ${baseUrl}/<handle>/search.json?q=<query>
Authorization: Bearer doco_pt_<token>
\`\`\`

The token is fixed at **reader** role on exactly one Doco. Writes
(POST/PATCH/DELETE) fail with HTTP 403 \`insufficient_scope\`. The
canonical bootstrap (\`GET /api/v1/agent-bootstrap.json\`) returns
the Doco's policies with \`principal: null\` and a
\`project_token_grant: { doco_id, role: "reader" }\` marker so
agents know which path they're on.

### Revoke

Same page or:

\`\`\`
DELETE ${baseUrl}/<handle>/api/project-tokens.json?id=<8-char-suffix>
Authorization: Bearer doco_at_<owner's-oauth-token>
\`\`\`

Revoking takes effect immediately. The committed token in the repo
becomes inert — remove or replace it in the next commit.

### Don't conflate project tokens with OAuth

\`doco_pt_…\` and \`doco_at_…\` are different credentials. Project
tokens have no refresh, no expiry, no collaborator identity, no
write scope. If your runtime needs to capture neurons or edit the
Doco, OAuth is still the path — project tokens cannot widen.

## Refreshing

Access tokens last 1 hour. When you get a 401, refresh:

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

The canonical machine-readable advertisement of these endpoints
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
