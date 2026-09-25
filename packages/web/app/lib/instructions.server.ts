/**
 * Canonical agent-protocol prose, served at
 * /protocol/canonical-instructions (public, text/markdown) and
 * embedded in /api/v1/agent-bootstrap.json.
 *
 * Structure: the three reply invariants come FIRST (what an agent does
 * every turn), then the connection/credential mechanics some runtimes
 * need as reference below. A doc that opens with the rules is followed
 * better than one that buries them under auth plumbing.
 *
 * MCP delivery: agents in MCP-aware runtimes (Claude Code, Cursor,
 * Codex CLI) auto-discover this project's MCP server via .mcp.json
 * and read the protocol summary from the server's
 * `serverInfo.instructions` field. This file remains the authoritative
 * long-form source — agents fetch it on demand for the full reference.
 *
 * `AGENT_REFERENCE` is the long-form deep reference (node walkthrough,
 * placement examples).
 */

export const CANONICAL_INSTRUCTIONS = `# Doco — agent protocol (slim)

## What is Doco?

You're working on a project that uses **Doco** — institutional memory
for software projects. Doco is a structured, searchable, typed record
of a project's intent, decisions, rules, actions, history, and the
artifacts they touch, purpose-built for AI agents and humans to share
context.

Git records *what* changed in the code. Doco records the surrounding
graph the code can't hold: the **intents** behind work, the
**decisions** taken and the alternatives weighed, the **rules** that
emerged, the **actions** designed, the **logs** of what actually
happened (incidents, fixes, releases), the **evals** that pin
load-bearing claims, the **references** to external artifacts (pull
requests, issues, docs), the **states** a process moves through, and
the **principals** who own it — as typed, linked nodes you can query
across the project's whole lifetime.

For you, the agent, this means:

- Before answering substantive questions, search the doco. Prior
  decisions and rules likely shape the right answer.
- When you make a non-trivial choice or finish load-bearing work,
  follow this doco's policies to decide what, if anything, to
  capture. **Each doco sets its own capture rules — the universal
  protocol does not mandate captures.**
- Avoid contradicting Decisions and Rules already in the doco.

Use Doco naturally as a verb when you talk with the project owner:
"Want me to doco it?", "Doco this decision", "Doco this ADR", and
"Doco the flow" are all normal client-facing phrases. When a project
owner says "doco it", interpret that as a request to capture per
this doco's policies.

The **three invariants** below govern every reply, so they come first —
they're what you do on every turn. The connection and credential
mechanics some runtimes need follow after: they're about how you
*connect*, not how you *reply*, and the invariants hold whichever way
you connected.

## 1. TOP OF EVERY REPLY — connection indicator

Render indicators in **rendering order around tool calls**. Text
between tool calls is shown to the user as those tool calls run, so
use that ordering to communicate "what I'm about to do" vs. "what I
just finished." Don't batch everything at the end.

**On the first reply of a session that uses Doco**, render the
Loading line as the very first text, BEFORE any MCP tool call:

\`\`\`
[🔮 Doco] Loading <doco_handle>...
\`\`\`

The trailing \`...\` is required. If this turn doesn't touch Doco at
all (greeting, one-word ack, off-topic), emit nothing.

**When you call \`doco_search\`**, render the corky verb on its own
line IMMEDIATELY BEFORE the tool call (so the user sees it as the
query is sent), then the N-found line AFTER the result returns:

\`\`\`
[🔮 Doco] <querying-verb>

   ← tool call here

[🔮 Doco] <N> relevant nodes found (<X.X>s)
\`\`\`

**Don't hand-build that N-found line — paste it.** Every \`doco_search\`
result carries a \`display\` object with the exact lines already
formatted from your credential: \`display.found\` is the
"<N> relevant nodes found (<X.X>s)" line above, and \`display.tally\`
is the closing tally (§3). Emit \`display.found\` verbatim after the
result, and \`display.tally\` verbatim as your last line. The server
owns the format so you can't drift from it; only fall back to
constructing the line by hand when a result lacks \`display\`.

**Your Doco credential label.** Every \`doco_search\` response may carry
\`viewer.indicator_prefix\`, and \`doco_complete_authentication\` returns
an "Authenticated as <credential>" block. Once you know the prefix, use it
verbatim for every Doco indicator line. For OAuth/API-key agents this
looks like \`[🔮 Doco <token nickname> on behalf of @username]\`, so the
query/count/tally lines become \`[🔮 Doco <token nickname> on behalf of
@username] <querying-verb>\`, \`[🔮 Doco <token nickname> on behalf of
@username] <N> relevant nodes found …\`, and the closing tally. If the
response lacks \`viewer.indicator_prefix\` but has \`viewer.username\`,
fall back to \`[🔮 Doco @username]\`. Before you know either (the very
first line of a cold session, before any search returns), plain
\`[🔮 Doco]\` is fine.

Pick \`<querying-verb>\` at random:

Querying... · Looking it up... · Asking around... · Reading the room... ·
Sniffing for hits... · Flipping through notes... · Scanning the graph... ·
Searching the lore... · Peering into the orb... · Combing the archive... ·
Hunting for prior art... · Pinging the memory... · Cross-referencing... ·
Checking what's known... · Tracing the trail... · Diving in... ·
Polling the doco... · Skimming the index... · Asking the oracle... · Searching...

**Only render the verb if you have DOCO_ACCESS, or a shared \`.env\`
with DOCO_REFRESH + DOCO_CLIENT_ID, and expect the search to succeed.**
If both DOCO_ACCESS and refresh credentials are missing, skip the
search and go to the not-connected flow below — no verb. If your
credential turns out invalid (401) and local refresh cannot recover
it, it's fine that the verb appeared; follow up with the not-connected
flow.

If you didn't need to query (greeting, one-word ack), emit nothing
at the top — no "Not querying" placeholder. Absence is the signal.

**If Doco access isn't granted** (no usable DOCO_ACCESS and no usable
DOCO_REFRESH/DOCO_CLIENT_ID after checking the shared repo-root
\`.env\`, or \`doco_search\` returned 401/403 after refresh, or the
bootstrap couldn't reach Doco):

1. Call \`doco_authenticate\` to get the verification URL.
2. Render the block returned by \`doco_authenticate\` at the top of
   your reply:

   \`\`\`
   [🔮 Doco] <doco-or-workspace-name> access not granted yet

   To let me read this project's prior decisions and rules, open
   [<URL>](<URL>) and click Approve. I'll pause here until you do.
   \`\`\`

   The URL must be wrapped in markdown link syntax so it renders
   clickable.
3. **Immediately call \`doco_complete_authentication\` with
   \`wait_seconds: 120\` in the same turn.** Do not wait for the user
   to send another message saying they approved; the tool blocks while
   polling so the agent can learn when approval lands.
4. **If it succeeds**: \`doco_complete_authentication\` returns an
   "Authenticated as <credential>. I've got the following levels of
   access:" block — render it verbatim at the top of your reply, then
   retry \`doco_search\` and continue with the substantive answer using
   the now-available doco.
5. **If it returns "still pending" or any error**: end your reply
   with a short "I'll wait — send any message when you've approved"
   plus the tally line. **Do NOT continue substantive work without
   Doco access.** Doco contains prior decisions and rules; doing
   work that hasn't checked them risks contradicting them.

**The query has two jobs:**

1. **Inform.** Let prior Decisions, Rules, and Intents shape what
   you say and do. An answer that contradicts a documented Decision
   because you didn't check is a defect.
2. **Deduplicate.** Before suggesting a new node, scan for nodes
   that already cover the same territory. Patch the existing one
   rather than create a near-duplicate.

## 2. AFTER EVERY WRITE — footer_lines verbatim

When the project owner captures a node on your behalf (via the web
UI), the host returns \`footer_lines: string[]\` from the capture
endpoint. If they share those with you, paste them verbatim, one
per line:

\`\`\`
[🔮 Doco] <op-icon> <Type> <verb>: [<summary>](<url>) (✅ <n> authoring policies passed in <X.Xs>)
\`\`\`

Op icons: ✍️ added · 📝 updated · 🧹 cleared · ➕ added/appended ·
➖ removed · 🔁 replaced · 🏷️ renamed · 🗑️ deleted.

## 3. CLOSING LINE OF THE TURN — tally (no exceptions, once per turn)

Render one tally line per source the agent has potential access to
(each doco or workspace listed in the project's connections).

**Connected source** (you queried or wrote — even if N == 0):

\`\`\`
[🔮 Doco <token nickname> on behalf of @username] <doco-or-workspace-name>: **<N>** nodes added/updated
\`\`\`

(Use \`viewer.indicator_prefix\` once you know it — see "Your Doco
credential label" in section 1. Fall back to \`[🔮 Doco @username]\`
only when no credential-aware prefix is provided. Plain \`[🔮 Doco]\`
only before your first search of a cold session.)

**Paste \`display.tally\`, don't rebuild it.** The \`doco_search\`
result hands you \`display.tally\` — this exact line, already formatted
with your credential and the source you queried, for a read-only turn
(**0**). If the turn captured nothing, emit it verbatim as your last
line. If you DID capture, bump **0** to the number of nodes you wrote
this turn — one per capture \`footer_lines\` line. This is the same
"echo the server-provided string" contract as \`footer_lines\` (§2):
the host owns the format so the ritual can't drift.

**Source whose access hasn't been granted yet**:

\`\`\`
[🔮 Doco] ⚠️ <doco-or-workspace-name> not queried or updated as access hasn't been granted yet.
\`\`\`

The tally lines are the LAST lines of the LAST text output of the turn.

- \`<doco-or-workspace-name>\` is the human-readable doco handle if access is
  scoped to one doco, or the workspace name if access is granted
  workspace-wide (covering multiple docos under that workspace).
- \`<N>\` counts distinct entities the project owner captured on your
  behalf this turn (patch-3-fields-of-1-Decision = 1).
- \`<N>\` MUST be wrapped in markdown bold (\`**N**\`).
- Singular form for \`**1**\`; plural otherwise (zero is plural).
- The connected-source line renders EVEN when N == 0 — that's the
  explicit no-op signal.
- The not-granted-yet line replaces the normal tally for that source
  until access is granted (then switch to the normal line).

## Connecting and writing — the mechanics

Everything below is reference: how to reach a doco, authenticate, and
write to it. Read it when you need it — the three invariants above are
the part you apply on every turn, whichever way you connected.

There are two access channels — pick the one your runtime supports.

**MCP** (preferred, MCP-aware runtimes). Doco-tracked repos ship
\`.mcp.json\` registering an MCP server at
\`.agents/doco-mcp-server.mjs\`. The server exposes these tools:

  - \`doco_search\` — query the project's doco for relevant prior
    context. Cheap; call before answering substantive questions. If
    repo-root \`.env\` has \`DOCO_REFRESH\` + \`DOCO_CLIENT_ID\`,
    it refreshes a missing or stale \`DOCO_ACCESS\` locally before
    falling back to device flow.
  - \`doco_get\` — read the authoring contract, capture policies,
    status, a node by id, or a type listing (read) — the read
    surface beyond search.
  - \`doco_capture\` — record a decision/intent/rule/etc. as it
    forms (write; needs writer).
  - \`doco_relate\` — link two nodes with a typed edge (write).
  - \`doco_changeset\` — create and wire many nodes in one atomic
    batch (write; the efficient way to import a process or backfill
    history without dozens of single calls).
  - \`doco_policy\` — write or modify a Doco's authoring policies
    (write; owner only). Omit \`id\` to create; pass an existing
    policy \`id\` to modify (a draft supersedes it, \`{lifecycle}\`
    retires or re-activates).
  - \`doco_authenticate\` — start OAuth device flow when a call
    returns 401/403. Returns a ready-to-render block with a
    clickable verification URL.
  - \`doco_complete_authentication\` — finalize after the user
    approves. Writes DOCO_ACCESS to the repo-root ./.env and clears
    state.

MCP delivers tool descriptions and the \`serverInfo.instructions\`
field in clean framing (no claudeMd-style "may not be relevant"
wrapper), so this is the channel that survives sandboxed agent
runtimes where project-scope hooks are filtered.

The hosted remote MCP connector lives at \`/mcp\` — one connection whose
reach comes from your token. An "act as me" (\`actor\`) token reaches
**every** workspace you belong to; a workspace-scoped token pins you to a
single one. Authentication belongs to the MCP client transport: do not
hand-drive OAuth or ask the user to paste localhost callback URLs back
into chat; if the callback listener fails, restart the client MCP auth
flow. Use the direct OAuth recipes only when you are not connected
through remote MCP.

**Know your reach, and use all of it.** Call \`doco_whoami\` — and
\`list_workspaces\` — to see what your credential covers: one workspace,
several, or specific docos, exactly as the user granted. That grant is
your scope and the user chose it deliberately, so work across whatever
workspaces and docos the task needs — never cap yourself at one. Each
tool call names a doco by its \`<handle>\`, in any workspace you reach.
Honor each workspace's constitution and policies as you go.

**Direct HTTP** (any runtime, or when MCP isn't available). You
drive OAuth directly. Two recipes, full step-by-step at:

    https://doco.to/protocol/agent-oauth-recipe

  **Recipe A — Localhost loopback** (shell-capable agents: Claude
    Code, Cursor, Codex CLI, anything that can bind a port and
    \`open\` a browser). Standard PKCE + authorize URL + a tiny local
    listener catches the redirect. Same shape as \`gh auth login\`.

  **Recipe B — Device Authorization Grant, RFC 8628** (chat-only or
    sandboxed agents: claude.ai chat, ChatGPT, runtimes without
    port binding). You POST to /oauth/device_authorization, get
    back a short user_code like \`WXYZ-1234\`, show it to the user,
    they approve at /device, you poll /oauth/token until you get
    the token. The MCP tool \`doco_authenticate\` automates this.

Both recipes end with you holding a \`doco_at_…\` Bearer token. After
that, every API call is:

    GET https://doco.to/<handle>/<endpoint>
    Authorization: Bearer doco_at_<token>

The \`<handle>\` is a **doco** — the unit every endpoint addresses.
One project = one Workspace; each doco in it holds one kind of that
project's knowledge (decisions, ideas, bugs, …), so a new project gets a
new Workspace, never a lone doco inside another project's workspace.
Access is granted to you at one of two levels: a **Workspace** (covers
every doco in it — the common case when an owner invites an agent) or a
**single doco**. \`GET /api/v1/whoami.json\` returns both — the
Workspaces you can reach and the docos inside them, each with your role
— so you find a project's handle without guessing instead of asking.

### Repo-local credential sharing

If you are operating inside a Doco-tracked repository, the repository
root \`.env\` is the shared credential store for agents running in
that **same local checkout**:

- Read \`DOCO_ACCESS\`, \`DOCO_REFRESH\`, \`DOCO_CLIENT_ID\`, and
  \`DOCO_HOST\` from repo-root \`.env\` before asking the user to
  authorize.
- When OAuth succeeds, write the tokens back to that same \`.env\`
  with private permissions (0600 where your runtime supports it).
- Prefer the repo-root \`.env\` value over stale inherited
  \`process.env\` values, and reread it before each Doco call if your
  process is long-lived. Another local agent may have refreshed or
  created the credential moments ago.
- If \`DOCO_ACCESS\` is missing or expired but \`.env\` has
  \`DOCO_REFRESH\` and \`DOCO_CLIENT_ID\`, exchange the refresh token
  at \`/oauth/token\`, write the new access token back to \`.env\`,
  and retry the Doco call before asking the user to authorize again.
- Never commit \`.env\` or token values. Separate clones, worktrees,
  machines, and remote sandboxes need their own local \`.env\` because
  credentials are secret; they share only the committed Doco bootstrap
  files.

Do not ask the user to approve a new device/browser authorization
just because this agent process did not start with credentials. First
check the shared repo-root \`.env\`; if another same-checkout agent
already authorized, reuse that token and continue. If the same-checkout
\`.env\` holds a refresh credential, mint a fresh access token locally
and continue.

### Persisting credentials across containers, clones, machines

After a successful OAuth completion, **surface to the user once** that
the auth dance repeats on every fresh container or new clone unless
they persist the credential — the repo-root \`.env\` is per-checkout and
does not travel to a fresh cloud container. Pick by what the agent
needs:

1. **Pin the credential as env vars (recommended for ephemeral
   runtimes).** Mint a token at \`/tokens\`, scope it, and set the
   revealed \`DOCO_REFRESH\` + \`DOCO_CLIENT_ID\` (and optionally
   \`DOCO_ACCESS\`) as environment variables on the runtime (Claude Code
   on the Web env vars, Codespaces / Replit secrets, etc.). Refresh
   tokens are non-rotating, so every fresh instance mints its own
   short-lived access token from the same pinned refresh token — no
   re-approving, and the pinned value never goes stale. Private to the
   user; never commit. Revoke from the same page.

2. **Read-only, shareable with the repo.** The doco owner mints a
   read-only token at \`/<handle>/project-tokens\` (owner-only) and
   commits it to \`.doco/project-tokens.json\` as
   \`{"<handle>": "doco_pt_<token>"}\`. The MCP server reads this file
   automatically as a fallback for \`DOCO_ACCESS\`. Only suitable when
   the doco's contents are OK to be readable by anyone with read access
   to the repo — minting requires an explicit confirmation to that
   effect. Reader-only, indefinite TTL, revoke from the same page.

3. **Quick and low-stakes: DOCO_ACCESS as a runtime env var.** Set the
   access token alone on the runtime. Simplest, but it expires at the
   access-token TTL and then falls back to device flow — fine for
   short-lived or read-mostly use, not for long-running cloud agents.

All optional. Surface them once, immediately after each successful
auth, then continue with the substantive answer. Do not re-prompt on
every turn.

If the doco is **public**, you can skip OAuth entirely. Either way,
the endpoint shapes are:

    GET   https://doco.to/<handle>/status.json              # counts + freshness
    GET   https://doco.to/<handle>/api/<type>.json          # list nodes
    POST  https://doco.to/<handle>/api/<type>.json          # capture (needs write access)
    GET   https://doco.to/<handle>/api/<type>/<id>.json     # one node
    PATCH https://doco.to/<handle>/api/<type>/<id>.json     # patch (needs write access)
    GET   https://doco.to/<handle>/api/<type>.txt           # plain-text spec for capture-capable types
    GET   https://doco.to/<handle>/api/policies.json      # list policies
    POST  https://doco.to/<handle>/api/policies.json      # capture a policy (needs write access)

Node types: intents, ideas, rules, decisions, actions, logs, evals,
references, states, principals.

Capture body specs exist for decisions, intents, actions, logs, rules,
evals, references, states, ideas, policies, settings, and principals.
Principals expose a smaller surface (create + retire only) — read the
\`principals.txt\` spec rather than assuming the generic capture body.
Invites and audit have dedicated route behavior; don't infer write
bodies for them from the generic capture pattern.

Policies are NOT nodes. Policies (a single \`policy\` entity type)
live on the dedicated \`/api/policies.json\` endpoint and inside the
bootstrap payload — never on the generic \`/api/<type>.json\` route.

### Capture body structure

Before POST/PATCH, read \`GET /<handle>/api/<type>.txt\` for the
exact per-type body when that spec exists. Node request bodies contain
prose and scalar metadata only. Put relationships in first-class edges
with \`POST /<handle>/api/changesets.json\` or
\`POST /<handle>/api/edges.json\`.

\`created_by\` / \`updated_by\` are user/API-key provenance derived from
the authenticated session or token. Never send \`created_by\` in request
bodies.

Intent capture example:

    POST https://doco.to/<handle>/api/intents.json
    {
      "intent": "Checkout can be completed without support."
    }

Action capture example:

    POST https://doco.to/<handle>/api/actions.json
    {
      "action": "Implemented edge-only relationship capture.",
      "verb": "implemented",
      "outputs": { "commit": "abc123" }
    }

Public docos return 200 for unauthenticated reads; private docos
return 403 until you finish the OAuth recipe.

### Bootstrap: read the policies

Every doco has a set of **policies** — short, project-owner-authored
statements that govern how you, the agent, author nodes inside it.
There is one \`policy\` entity type; each carries a standalone
\`kind\`, all surfaced at bootstrap:

  - **suggestion** — a single natural-language \`agent_instruction\`
    for context. No automated check. Read it and let it shape your
    judgement.
  - **deterministic** — a \`predicate\` evaluated when you capture a
    node ("every Decision cites at least one Intent"). \`on_violation:
    block\` means the host will reject your capture.
  - **probabilistic** — an \`agent_instruction\` the host evaluates
    with an LLM when you capture a node. \`on_violation: block\` means
    the host will reject your capture.

Policies apply only to their doco. Treat them as binding on your
authoring at all times.

The project owner can **add, edit, or remove policies any time**,
at \`/<handle>/policies\`. Re-bootstrap if you suspect they've
changed mid-session.

Each policy also has its own stable, linkable page at
\`https://doco.to/<handle>/policies/<policy_id>\`. You already hold the
\`<handle>\` (per doco) and every policy's \`id\` from the bootstrap
payload below, so you can always build this URL. **Whenever you refer
to, cite, or quote a policy — in chat, a PR comment, a commit message,
anywhere — link to it at that URL** so the reader can open the exact
policy you mean.

Once you hold a Bearer token, hit:

    GET https://doco.to/api/v1/agent-bootstrap.json
    Authorization: Bearer doco_at_<token>

The response carries the policies for every doco you have
read-or-above access to, exposed as a single \`policies[]\` array,
each entry carrying its \`kind\`.

## Doco is the memory — your private memory isn't

Project-shaped knowledge lives **in this doco**, not in your private
agent memory (Claude memory files, ChatGPT system notes, scratch
files). Other contributors on this doco can't read your private
memory; the next session of *you* can't either, reliably. The doco
is the shared source of truth — that's the whole point.
`;

export const AGENT_REFERENCE = `# Doco — agent reference (long form)

This is the deep reference the canonical
(/protocol/canonical-instructions) points to. Fetch on demand, not
preemptively.

## The node + policy model

Doco's data model is a graph of typed nodes, plus a single \`policy\`
entity type that governs how nodes are authored:

- **Intent** — what someone wants. Source of every downstream Decision.
- **Decision** — a chosen resolution to a question, with alternatives
  weighed. Link it to Intents with \`serves\` edges.
- **Action** — a designed step in a process (imperative/present verb).
- **Log** — a recorded event that *did* happen (past-tense verb +
  \`happened_at\` + concrete outputs). Immutable once captured.
- **Rule** — an ongoing domain constraint.
- **Policy** — one entity type with a standalone \`kind\`. A
  \`suggestion\` is prose contributors read while working (no
  automated check); a \`deterministic\` predicate or a
  \`probabilistic\` instruction is evaluated when nodes are captured.
  The project owner can edit any policy any time from
  \`/<handle>/policies\`.
- **Eval** — a named, executable test pinning a load-bearing claim.
- **Reference** — an external pointer (URL, file, doc) with a summary.
- **State** — a node in a formal state machine.
- **Idea** — exploratory capture; promote to Intent / Decision once
  it firms up.
- **Principal** — a role-persona node linked through attributed_to and
  has_parent edges with roles such as \`performed_by\`, \`owned_by\`, and
  \`decided_by\`. Distinct from a User (the OAuth identity layer).

## Things only people can do

- Sign in to the host (via whichever providers it offers).
- Create / delete a doco.
- Approve OAuth device-flow grants at /device.
- Mint human collaboration invites.
`;
