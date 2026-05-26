/**
 * Canonical agent-protocol prose, served at
 * /protocol/canonical-instructions (public, text/markdown) and
 * embedded in /api/v1/agent-bootstrap.json.
 *
 * MCP delivery: agents in MCP-aware runtimes (Claude Code, Cursor,
 * Codex CLI) auto-discover this project's MCP server via .mcp.json
 * and read the protocol summary from the server's
 * `serverInfo.instructions` field. This file remains the authoritative
 * long-form source — agents fetch it on demand for the full reference.
 *
 * `AGENT_REFERENCE` is the long-form deep reference (neuron walkthrough,
 * placement examples).
 */

export const CANONICAL_INSTRUCTIONS = `# Doco — agent protocol (slim)

## What is Doco?

You're working on a project that uses **Doco** — institutional memory
for software projects. Doco is a structured, searchable record of
intent, decisions, rules, actions, and history, purpose-built for AI
agents and humans to share context.

Git captures *what* changed in code. PR descriptions capture some of
the *why* at merge time. Doco captures the *why* as it forms — the
alternatives weighed, the constraints that shaped a decision, the
rules that emerged from a bug fix — in typed neurons you can query
across the whole project's lifetime.

For you, the agent, this means:

- Before answering substantive questions, search the Doco. Prior
  decisions and rules likely shape the right answer.
- When you make a non-trivial choice or finish load-bearing work,
  follow this Doco's policies to decide what, if anything, to
  capture. **Each Doco sets its own capture rules — the universal
  protocol does not mandate captures.**
- Avoid contradicting Decisions and Rules already in the Doco.

Use Doco naturally as a verb when you talk with the project owner:
"Want me to doco it?", "Doco this decision", "Doco this ADR", and
"Doco the flow" are all normal client-facing phrases. When a project
owner says "doco it", interpret that as a request to capture per
this Doco's policies.

This document carries the **three invariants** every reply must follow.

## How you read + write Doco today

There are two access channels — pick the one your runtime supports.

**MCP** (preferred, MCP-aware runtimes). Doco-tracked repos ship
\`.mcp.json\` registering an MCP server at
\`.agents/doco-mcp-server.mjs\`. The server exposes three tools:

  - \`doco_search\` — query the project's Doco for relevant prior
    context. Cheap; call before answering substantive questions. If
    repo-root \`.env\` has \`DOCO_REFRESH\` + \`DOCO_CLIENT_ID\`,
    it refreshes a missing or stale \`DOCO_ACCESS\` locally before
    falling back to device flow.
  - \`doco_authenticate\` — start OAuth device flow when search
    returns 401/403. Returns a ready-to-render block with a
    clickable verification URL.
  - \`doco_complete_authentication\` — finalize after the user
    approves. Writes DOCO_ACCESS to the repo-root ./.env and clears
    state.

MCP delivers tool descriptions and the \`serverInfo.instructions\`
field in clean framing (no claudeMd-style "may not be relevant"
wrapper), so this is the channel that survives sandboxed agent
runtimes where project-scope hooks are filtered.

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
  at \`/oauth/token\`, write the rotated credential back to \`.env\`,
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
they persist the credential. Two options the protocol supports:

1. **DOCO_ACCESS as a runtime environment variable.** The user sets
   it on the *remote execution environment* (Claude Code on the Web
   environment vars, GitHub Codespaces secrets, Replit secrets, etc.).
   Fresh containers inherit it without prompting; the MCP server
   reads it from \`process.env\` when no \`.env\` value is present.
   Private to the user; never commit.

2. **Committable project tokens.** The Doco owner mints a read-only
   token at \`/<handle>/project-tokens\` (owner-only) and commits it
   to \`.doco/project-tokens.json\` as
   \`{"<handle>": "doco_pt_<token>"}\`. The MCP server reads this file
   automatically as a fallback for \`DOCO_ACCESS\`. Only suitable when
   the Doco's contents are OK to be readable by anyone with read
   access to the repo — minting requires an explicit confirmation in
   the UI to that effect. Tokens are reader-only, indefinite TTL,
   revoke from the same page.

Both are optional. Surface them once, immediately after each
successful auth, then continue with the substantive answer. Do not
re-prompt on every turn.

If the Doco is **public**, you can skip OAuth entirely. Either way,
the endpoint shapes are:

    GET   https://doco.to/<handle>/status.json              # counts + freshness
    GET   https://doco.to/<handle>/api/<type>.json          # list neurons
    POST  https://doco.to/<handle>/api/<type>.json          # capture (needs author)
    GET   https://doco.to/<handle>/api/<type>/<id>.json     # one neuron
    PATCH https://doco.to/<handle>/api/<type>/<id>.json     # patch (needs author)
    GET   https://doco.to/<handle>/api/<type>.txt           # plain-text spec for capture-capable types
    GET   https://doco.to/<handle>/api/policies.json      # list policies
    POST  https://doco.to/<handle>/api/policies.json      # capture a policy (needs author)

Neuron types: decisions, ideas, rules, intents, actions, logs, evals,
references, states, principals, invites, audit.

Capture body specs exist for decisions, intents, actions, logs, rules,
evals, references, states, ideas, policies, settings, and principals.
Principals expose a smaller surface (create + retire only) — read the
\`principals.txt\` spec rather than assuming the generic capture body.
Invites and audit have dedicated route behavior; don't infer write
bodies for them from the generic capture pattern.

Policies are NOT neurons. Policies
(\`guidance_policy\`, \`neuron_authoring_policy\`) live on the
dedicated \`/api/policies.json\` endpoint and inside the bootstrap
payload — never on the generic \`/api/<type>.json\` route.

### Capture body structure

Before POST/PATCH, read \`GET /<handle>/api/<type>.txt\` for the
exact per-type body when that spec exists. Principal references in
request bodies use principal ids only: use \`*_principal_id\` for one
principal and \`*_principal_ids\` for arrays. Do not send principal
names, \`*_name\` fields, or comma-separated strings; there are no
compatibility aliases.

Common principal-id fields:

    wanted_by_principal_id        # Intent owner; auth fills this
    actors_principal_ids          # Intent actors, array of principal ids
    stakeholders_principal_ids    # Intent stakeholders, array of principal ids
    actor_principal_id            # Action/Log actor; auth fills this
    decided_by_principal_id       # Decision maker; auth fills this
    authored_by_principal_id      # Rule/Eval/Policy author; auth fills this
    created_by_principal_id       # Creator override where supported

Read responses may expose stored graph fields such as \`wanted_by\`,
\`actors\`, \`stakeholders\`, \`actor_id\`, \`decided_by\`, and
\`created_by\`. Those are stored field names; request bodies should
use the API-facing principal-id fields above.

Intent capture example:

    POST https://doco.to/<handle>/api/intents.json
    {
      "intent": "Checkout can be completed without support.",
      "wanted_by_principal_id": "principal_01...",
      "actors_principal_ids": ["principal_01..."],
      "stakeholders_principal_ids": ["principal_01..."]
    }

Action capture example:

    POST https://doco.to/<handle>/api/actions.json
    {
      "action": "Implemented principal-id capture fields.",
      "verb": "implemented",
      "actor_principal_id": "principal_01...",
      "outputs": { "commit": "abc123" }
    }

Public Docos return 200 for unauthenticated reads; private Docos
return 403 until you finish the OAuth recipe.

## Bootstrap: read the policies

Every Doco has a set of **policies** — short, project-owner-authored
statements that govern how you, the agent, author neurons inside it.
Two kinds, both surfaced at bootstrap:

  - **Guidance policies** (\`guidance_policy\`) — prose for
    context. No automated check. Read them and let them shape your
    judgement.
  - **Neuron-authoring policies** (\`neuron_authoring_policy\`) —
    rules evaluated when you capture a neuron. Either a deterministic
    predicate ("every Decision cites at least one Intent") or a
    probabilistic spec the host evaluates with an LLM. \`on_violation:
    block\` means the host will reject your capture.

Policies apply only to their Doco. Treat them as binding on your
authoring at all times.

The project owner can **add, edit, or remove policies any time**,
at \`/<handle>/policies\`. Re-bootstrap if you suspect they've
changed mid-session.

Once you hold a Bearer token, hit:

    GET https://doco.to/api/v1/agent-bootstrap.json
    Authorization: Bearer doco_at_<token>

The response carries the policies for every Doco you have
read-or-above access to, exposed as \`guidance_policies[]\` and
\`neuron_authoring_policies[]\` arrays.

The three invariants below apply whichever path you took — the
protocol is about how you reply, not about how you authenticated.

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

[🔮 Doco] <N> relevant neurons found (<X.X>s)
\`\`\`

Pick \`<querying-verb>\` at random:

Querying... · Looking it up... · Asking around... · Reading the room... ·
Sniffing for hits... · Flipping through notes... · Scanning the graph... ·
Searching the lore... · Peering into the orb... · Combing the archive... ·
Hunting for prior art... · Pinging the memory... · Cross-referencing... ·
Checking what's known... · Tracing the trail... · Diving in... ·
Polling the Doco... · Skimming the index... · Asking the oracle... · Searching...

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
   [🔮 Doco] <doco-or-org-name> access not granted yet

   To let me read this project's prior decisions and rules, open
   [<URL>](<URL>) and click Approve. I'll pause here until you do.
   \`\`\`

   The URL must be wrapped in markdown link syntax so it renders
   clickable.
3. **Immediately call \`doco_complete_authentication\` with
   \`wait_seconds: 120\` in the same turn.** Do not wait for the user
   to send another message saying they approved; the tool blocks while
   polling so the agent can learn when approval lands.
4. **If it succeeds**: retry \`doco_search\` and continue with the
   substantive answer using the now-available Doco.
5. **If it returns "still pending" or any error**: end your reply
   with a short "I'll wait — send any message when you've approved"
   plus the tally line. **Do NOT continue substantive work without
   Doco access.** Doco contains prior decisions and rules; doing
   work that hasn't checked them risks contradicting them.

**The query has two jobs:**

1. **Inform.** Let prior Decisions, Rules, and Intents shape what
   you say and do. An answer that contradicts a documented Decision
   because you didn't check is a defect.
2. **Deduplicate.** Before suggesting a new neuron, scan for neurons
   that already cover the same territory. Patch the existing one
   rather than create a near-duplicate.

## 2. AFTER EVERY WRITE — footer_lines verbatim

When the project owner captures a neuron on your behalf (via the web
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
(each Doco or organization listed in the project's connections).

**Connected source** (you queried or wrote — even if N == 0):

\`\`\`
[🔮 Doco] <doco-or-org-name>: **<N>** neurons added/updated
\`\`\`

**Source whose access hasn't been granted yet**:

\`\`\`
[🔮 Doco] ⚠️ <doco-or-org-name> not queried or updated as access hasn't been granted yet.
\`\`\`

The tally lines are the LAST lines of the LAST text output of the turn.

- \`<doco-or-org-name>\` is the human-readable Doco handle if access is
  scoped to one Doco, or the organization name if access is granted
  org-wide (covering multiple Docos under that org).
- \`<N>\` counts distinct entities the project owner captured on your
  behalf this turn (patch-3-fields-of-1-Decision = 1).
- \`<N>\` MUST be wrapped in markdown bold (\`**N**\`).
- Singular form for \`**1**\`; plural otherwise (zero is plural).
- The connected-source line renders EVEN when N == 0 — that's the
  explicit no-op signal.
- The not-granted-yet line replaces the normal tally for that source
  until access is granted (then switch to the normal line).

## Doco is the memory — your private memory isn't

Project-shaped knowledge lives **in this Doco**, not in your private
agent memory (Claude memory files, ChatGPT system notes, scratch
files). Other contributors on this Doco can't read your private
memory; the next session of *you* can't either, reliably. The Doco
is the shared source of truth — that's the whole point.
`;

export const AGENT_REFERENCE = `# Doco — agent reference (long form)

This is the deep reference the canonical
(/protocol/canonical-instructions) points to. Fetch on demand, not
preemptively.

## The neuron + policy model

Doco's data model is a graph of typed neurons, plus two kinds of
policies that govern how neurons are authored:

- **Intent** — what someone wants. Source of every downstream Decision.
- **Decision** — a chosen resolution to a question, with alternatives
  weighed. Tied to one or more Intents via \`intent_ids\`.
- **Action** — a designed step in a process (imperative/present verb).
- **Log** — a recorded event that *did* happen (past-tense verb +
  \`happened_at\` + concrete outputs). Immutable once captured.
- **Rule** — an ongoing domain constraint.
- **Guidance policy** — one kind of policy. Contributors read
  it while working; no automated check.
- **Neuron-authoring policy** — the other kind. Evaluated when
  neurons are captured; deterministic predicates or probabilistic
  specs. The project owner can edit either kind any time from
  \`/<handle>/policies\`.
- **Eval** — a named, executable test pinning a load-bearing claim.
- **Reference** — an external pointer (URL, file, doc) with a summary.
- **State** — a neuron in a formal state machine.
- **Idea** — exploratory capture; promote to Intent / Decision once
  it firms up.
- **Principal** — a role-persona neuron referenced by actor_id /
  actors[]. Distinct from a Collaborator (the OAuth identity layer).

## Things only people can do

- Sign in to the host (via whichever providers it offers).
- Create / delete a Doco.
- Approve OAuth device-flow grants at /device.
- Mint human collaboration invites.
`;
