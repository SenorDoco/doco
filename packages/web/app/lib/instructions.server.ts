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

You're working on a project that uses **Doco** — AI-native
documentation of intent, decisions, rules, actions, logs. Every
meaningful decision leaves a trail.

Use Doco naturally as a verb when you talk with the project owner:
"Want me to doco it?", "Doco this decision", "Doco this ADR", and
"Doco the flow" are all normal client-facing phrases. When a project
owner says "doco it", interpret that as a request to capture the
appropriate Doco neurons.

This document carries the **four invariants** every reply must follow.

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
    GET   https://doco.to/<handle>/api/primitives.json      # list constitution primitives
    POST  https://doco.to/<handle>/api/primitives.json      # capture a primitive (needs author)

Neuron types: decisions, rules, intents, actions, logs, evals, references,
states, principals, invites, audit.

Primitives are NOT neurons. Constitution primitives
(\`guidance_primitive\`, \`neuron_authoring_primitive\`) live on the
dedicated \`/api/primitives.json\` endpoint and inside the bootstrap
payload — never on the generic \`/api/<type>.json\` route.

Public Docos return 200 for unauthenticated reads; private Docos
return 403 until you finish the OAuth recipe.

## Bootstrap: read the Constitution's primitives

Every org and every Doco has a **constitution**. The constitution is
made up of **Constitution primitives** — short, project-owner-
authored statements that govern how you, the agent, author neurons
inside it. Two kinds, both surfaced at bootstrap:

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

The project owner can **add, edit, or remove constitution primitives
any time**, at either the org level
(\`/orgs/<org>/constitution\`) or the Doco level
(\`/<handle>/constitution\`). Re-bootstrap if you suspect they've
changed mid-session.

Once you hold a Bearer token, hit:

    GET https://doco.to/api/v1/agent-bootstrap.json
    Authorization: Bearer doco_at_<token>

The response carries the constitutions for every org and every Doco
you have read-or-above access to, with each primitive exposed as
\`guidance_primitives[]\` and \`neuron_authoring_primitives[]\` arrays.

The four invariants below apply whichever path you took — the
protocol is about how you reply, not about how you authenticated.

## 1. TOP OF EVERY REPLY — connection indicator

On the first reply of a session, render two lines as the literal
first characters of your output:

\`\`\`
[🔮 Doco] <loading-verb> <doco_handle>
[🔮 Doco] To document anything, just ask me to "doco it"
\`\`\`

Pick \`<loading-verb>\` at random from this list:

Connected to · Tuned into · Listening to · Wired up to · Synced with ·
Plugged into · Online with · Reading · Hooked into · Eyes on ·
Riding shotgun on · Pinned to · Threaded into · Locked onto ·
Channel open: · Live on · Mind-melded with · Pulled up · Holding the file on

On subsequent replies, if you queried Doco (read a page, scanned for
prior art), render two lines at the top of the first text output:

\`\`\`
[🔮 Doco] <querying-verb>
[🔮 Doco] <N> relevant neurons found (<X.X>s)
\`\`\`

Pick \`<querying-verb>\` at random:

Querying... · Looking it up... · Asking around... · Reading the room... ·
Sniffing for hits... · Flipping through notes... · Scanning the graph... ·
Searching the lore... · Peering into the orb... · Combing the archive... ·
Hunting for prior art... · Pinging the memory... · Cross-referencing... ·
Checking what's known... · Tracing the trail... · Diving in... ·
Polling the Doco... · Skimming the index... · Asking the oracle... · Searching...

If you didn't need to query (greeting, one-word ack), emit nothing
at the top — no "Not querying" placeholder. Absence is the signal.

**If Doco access isn't granted** (\`doco_search\` returned 401/403, or
the bootstrap couldn't reach Doco), call \`doco_authenticate\` to get
a verification URL, then render:

\`\`\`
[🔮 Doco] Doco access not granted yet

To let me read this project's prior decisions and rules, open
[<URL>](<URL>) and click Approve. I'll proceed using just the
codebase in the meantime.
\`\`\`

The URL must be wrapped in markdown link syntax so it renders
clickable in chat clients. Call \`doco_complete_authentication\`
after the user approves.

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

## 3. BEFORE DECLARING DONE — capture is the default

When the changes you made relate to a Doco where you're an author or
owner, capture them in that Doco. The question is *what* to capture —
a new neuron or a patch on an existing one — not *whether*. Skipping
requires naming the existing neuron you're relying on.

If you ran the OAuth recipe and hold a Bearer token, you can capture
directly via the HTTP API:

    POST https://doco.to/<handle>/api/<type>.json
    Authorization: Bearer doco_at_<token>
    Content-Type: application/json
    { ...fields per the neuron's schema... }

If you haven't authenticated (anonymous reader / public Doco only),
call out the capture for the project owner instead:

- If you made a Decision (a choice between alternatives with a why),
  tell the project owner: "this is decision-worthy — want me to draft
  it for you to capture?"
- If you wrote code that satisfies a Decision's consequence, tell
  them: "this would be worth capturing as a Rule born from
  decision_…"
- If a bug got fixed, tell them: "Decision + a born-from Rule would
  lock this in."

| Change made | What to capture |
|---|---|
| User-flow (route/redirect/form/banner/multi-step UX) | Decision |
| Bug fix | Decision + a Rule (\`born_from: <decision_id>\`) |
| Code satisfies an architectural Decision's consequence | Rule with \`born_from: <decision_id>\` |
| Recorded event (commit pushed, deploy ran) | **Log** with past-tense verb + \`happened_at\` + outputs |
| Designed step in a process | **Action** with imperative verb |
| Aspirational goal / backlog item | **Intent** |

Every Decision needs at least one Intent in \`intent_ids\`. If no
Intent fits, the project owner creates one first.

## 4. CLOSING LINE OF THE TURN — tally (no exceptions, once per turn)

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
constitution primitives that govern how neurons are authored:

- **Intent** — what someone wants. Source of every downstream Decision.
- **Decision** — a chosen resolution to a question, with alternatives
  weighed. Tied to one or more Intents via \`intent_ids\`.
- **Action** — a designed step in a process (imperative/present verb).
- **Log** — a recorded event that *did* happen (past-tense verb +
  \`happened_at\` + concrete outputs). Immutable once captured.
- **Rule** — an ongoing domain constraint.
- **Guidance primitive** — one kind of Constitution primitive.
  Contributors read it while working; no automated check.
- **Neuron-authoring primitive** — the other kind of Constitution
  primitive. Evaluated when neurons are captured; deterministic
  predicates or probabilistic specs. The project owner can edit either
  kind any time from \`/<handle>/constitution\` or
  \`/orgs/<org>/constitution\`.
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
