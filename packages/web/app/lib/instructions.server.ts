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
  follow this Doco's primitives to decide what, if anything, to
  capture. **Each Doco sets its own capture rules — the universal
  protocol does not mandate captures.**
- Avoid contradicting Decisions and Rules already in the Doco.

Use Doco naturally as a verb when you talk with the project owner:
"Want me to doco it?", "Doco this decision", "Doco this ADR", and
"Doco the flow" are all normal client-facing phrases. When a project
owner says "doco it", interpret that as a request to capture per
this Doco's primitives.

This document carries the **three invariants** every reply must follow.

## How you read + write Doco today

There are two access channels — pick the one your runtime supports.

**MCP** (preferred, MCP-aware runtimes). Doco-tracked repos ship
\`.mcp.json\` registering an MCP server at
\`.agents/doco-mcp-server.mjs\`. The server exposes three tools:

  - \`doco_search\` — query the project's Doco for relevant prior
    context. Cheap; call before answering substantive questions.
  - \`doco_authenticate\` — start OAuth device flow when search
    returns 401/403. Returns a ready-to-render block with a
    clickable verification URL.
  - \`doco_complete_authentication\` — finalize after the user
    approves. Writes DOCO_ACCESS to ./.env and clears state.

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

If the Doco is **public**, you can skip OAuth entirely. Either way,
the endpoint shapes are:

    GET   https://doco.to/<handle>/status.json              # counts + freshness
    GET   https://doco.to/<handle>/api/<type>.json          # list neurons
    POST  https://doco.to/<handle>/api/<type>.json          # capture (needs author)
    GET   https://doco.to/<handle>/api/<type>/<id>.json     # one neuron
    PATCH https://doco.to/<handle>/api/<type>/<id>.json     # patch (needs author)
    GET   https://doco.to/<handle>/api/<type>.txt           # plain-text spec
    GET   https://doco.to/<handle>/api/primitives.json      # list primitives
    POST  https://doco.to/<handle>/api/primitives.json      # capture a primitive (needs author)

Neuron types: decisions, rules, intents, actions, logs, evals, references,
states, principals, invites, audit.

Primitives are NOT neurons. Primitives
(\`guidance_primitive\`, \`neuron_authoring_primitive\`) live on the
dedicated \`/api/primitives.json\` endpoint and inside the bootstrap
payload — never on the generic \`/api/<type>.json\` route.

Public Docos return 200 for unauthenticated reads; private Docos
return 403 until you finish the OAuth recipe.

## Bootstrap: read the primitives

Every org and every Doco has a set of **primitives** — short,
project-owner-authored statements that govern how you, the agent,
author neurons inside it. Two kinds, both surfaced at bootstrap:

  - **Guidance primitives** (\`guidance_primitive\`) — prose for
    context. No automated check. Read them and let them shape your
    judgement.
  - **Neuron-authoring primitives** (\`neuron_authoring_primitive\`) —
    rules evaluated when you capture a neuron. Either a deterministic
    predicate ("every Decision cites at least one Intent") or a
    probabilistic spec the host evaluates with an LLM. \`on_violation:
    block\` means the host will reject your capture.

Org-level primitives apply to every Doco that org owns. Doco-level
primitives apply only to that Doco. Treat both as binding on your
authoring at all times.

The project owner can **add, edit, or remove primitives any time**,
at either the org level (\`/orgs/<org>/constitution\`) or the Doco
level (\`/<handle>/constitution\`). Re-bootstrap if you suspect they've
changed mid-session.

Once you hold a Bearer token, hit:

    GET https://doco.to/api/v1/agent-bootstrap.json
    Authorization: Bearer doco_at_<token>

The response carries the primitives for every org and every Doco you
have read-or-above access to, exposed as \`guidance_primitives[]\` and
\`neuron_authoring_primitives[]\` arrays.

The four invariants below apply whichever path you took — the
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

**Only render the verb if you have DOCO_ACCESS and expect the search
to succeed.** If DOCO_ACCESS is empty, skip the search and go to the
not-connected flow below — no verb. If your DOCO_ACCESS turns out
invalid (401), it's fine that the verb appeared; follow up with the
not-connected flow.

**After a successful query on the first reply of the session**,
append the tagline AFTER the N-found line:

\`\`\`
[🔮 Doco] <N> relevant neurons found (<X.X>s)
[🔮 Doco] To document anything, just ask me to "doco it"
\`\`\`

The tagline appears ONLY after successful connection (200 from
\`doco_search\`), and only on the first reply of the session.

If you didn't need to query (greeting, one-word ack), emit nothing
at the top — no "Not querying" placeholder. Absence is the signal.

**If Doco access isn't granted** (no DOCO_ACCESS, or \`doco_search\`
returned 401/403, or the bootstrap couldn't reach Doco):

1. Call \`doco_authenticate\` to get the verification URL.
2. Render the block returned by \`doco_authenticate\` at the top of
   your reply:

   \`\`\`
   [🔮 Doco] Doco access not granted yet

   To let me read this project's prior decisions and rules, open
   [<URL>](<URL>) and click Approve. I'll pause here until you do.
   \`\`\`

   The URL must be wrapped in markdown link syntax so it renders
   clickable.
3. **Call \`doco_complete_authentication\` with \`wait_seconds: 120\`.**
   This blocks while polling — the intentional pause.
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
[🔮 Doco] <op-icon> <Type> <verb>: <body>
\`\`\`

Op icons: ✍️ added · 📝 updated · 🧹 cleared · ➕ added/appended ·
➖ removed · 🔁 replaced · 🏷️ renamed · 🗑️ deleted.

## 3. CLOSING LINE OF THE TURN — tally (no exceptions, once per turn)

\`\`\`
[🔮 Doco] <doco_handle>: **<N>** neuron(s) added/updated
\`\`\`

The tally is the LAST line of the LAST text output of the turn.

- \`<doco_handle>\` is the human-readable handle from the Doco URL.
- \`<N>\` counts distinct entities the project owner captured on your
  behalf this turn (patch-3-fields-of-1-Decision = 1).
- \`<N>\` MUST be wrapped in markdown bold (\`**N**\`).
- Singular form for \`**1**\`; plural otherwise (zero is plural).
- Renders EVEN when N == 0 — that's the explicit no-op signal.

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

## The neuron + primitive model

Doco's data model is a graph of typed neurons, plus two kinds of
primitives that govern how neurons are authored:

- **Intent** — what someone wants. Source of every downstream Decision.
- **Decision** — a chosen resolution to a question, with alternatives
  weighed. Tied to one or more Intents via \`intent_ids\`.
- **Action** — a designed step in a process (imperative/present verb).
- **Log** — a recorded event that *did* happen (past-tense verb +
  \`happened_at\` + concrete outputs). Immutable once captured.
- **Rule** — an ongoing domain constraint.
- **Guidance primitive** — one kind of primitive. Contributors read
  it while working; no automated check.
- **Neuron-authoring primitive** — the other kind. Evaluated when
  neurons are captured; deterministic predicates or probabilistic
  specs. The project owner can edit either kind any time from
  \`/<handle>/constitution\` or \`/orgs/<org>/constitution\`.
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
