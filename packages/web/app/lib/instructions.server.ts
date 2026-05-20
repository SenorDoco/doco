/**
 * Canonical agent-protocol prose, served at
 * /protocol/canonical-instructions (public, text/markdown).
 *
 * The MCP connector layer is currently removed — the protocol is
 * served via plain HTTP for now. When MCP returns, the same prose
 * will also be exposed as the `doco://protocol/canonical-instructions`
 * MCP resource.
 *
 * `AGENT_REFERENCE` is the long-form deep reference (node walkthrough,
 * scope onboarding, placement examples).
 */

export const CANONICAL_INSTRUCTIONS = `# Doco — agent protocol (slim)

You're working on a project that uses **Doco** — AI-native
documentation of intent, decisions, rules, actions, logs. Every
meaningful decision leaves a trail.

Use Doco naturally as a verb when you talk with the project owner:
"Want me to doco it?", "Doco this decision", "Doco this ADR", and
"Doco the flow" are all normal client-facing phrases. When a project
owner says "doco it", interpret that as a request to capture the
appropriate Doco nodes.

This document carries the **four invariants** every reply must follow.

## How you read + write Doco today

The MCP connector layer is removed for now — you drive OAuth
directly against the host. Two recipes, pick whichever your runtime
supports; the full step-by-step is at:

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
    the token.

Both recipes end with you holding a \`doco_at_…\` Bearer token. After
that, every API call is:

    GET https://doco.to/<handle>/<endpoint>
    Authorization: Bearer doco_at_<token>

If the Doco is **public**, you can skip OAuth entirely. Either way,
the endpoint shapes are:

    GET   https://doco.to/<handle>/status.json              # counts + freshness
    GET   https://doco.to/<handle>/api/<type>.json          # list nodes
    POST  https://doco.to/<handle>/api/<type>.json          # capture (needs author)
    GET   https://doco.to/<handle>/api/<type>/<id>.json     # one node
    PATCH https://doco.to/<handle>/api/<type>/<id>.json     # patch (needs author)
    GET   https://doco.to/<handle>/api/<type>.txt           # plain-text spec

Node types: decisions, rules, intents, actions, logs, evals,
references, states, scopes, principals, invites, audit.

Public Docos return 200 for unauthenticated reads; private Docos
return 403 until you finish the OAuth recipe.

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
[🔮 Doco] <N> relevant nodes found (<X.X>s)
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
[🔮 Doco] <op-icon> <Type> <verb>: <body> — <icon> <scope1>, <icon> <scope2>
\`\`\`

Op icons: ✍️ added · 📝 updated · 🧹 cleared · ➕ added/appended ·
➖ removed · 🔁 replaced · 🏷️ renamed · 🗑️ deleted.

## 3. BEFORE DECLARING DONE — capture is the default

Every turn that produced changes should be captured somewhere. The
question is *what to capture* — a new node or a patch on an existing
one — not *whether*. Skipping requires naming what you're relying on
instead. "Git will record it" is not a name; git records *what*, not
*why*.

If you ran the OAuth recipe and hold a Bearer token, you can capture
directly via the HTTP API:

    POST https://doco.to/<handle>/api/<type>.json
    Authorization: Bearer doco_at_<token>
    Content-Type: application/json
    { ...fields per the node's schema... }

If you haven't authenticated (anonymous reader / public Doco only),
call out the capture for the project owner instead:

- If you made a Decision (a choice between alternatives with a why),
  tell the project owner: "this is decision-worthy — want me to draft
  it for you to capture?"
- If you wrote code that satisfies a Decision's consequence, tell
  them: "this would be worth capturing as a Rule born from
  decision_…"
- If a bug got fixed, tell them: "Decision + a born-from Rule on the
  project's bug scope would lock this in."

| Change made | What to capture |
|---|---|
| User-flow (route/redirect/form/banner/multi-step UX) | Decision with **\`#user-flows\`** |
| Bug fix | Decision + a Rule with same scope (\`born_from: <decision_id>\`) |
| Code satisfies an architectural Decision's consequence | Rule with relevant scope, \`born_from: <decision_id>\` |
| Recorded event (commit pushed, deploy ran) | **Log** with past-tense verb + \`happened_at\` + outputs |
| Designed step in a process | **Action** with imperative verb |
| Aspirational goal / backlog item | **Intent** |

Every Decision needs at least one Intent in \`intent_ids\`. If no
Intent fits, the project owner creates one first.

## 4. CLOSING LINE OF THE TURN — tally (no exceptions, once per turn)

\`\`\`
[🔮 Doco] <doco_handle>: **<N>** node(s) added/updated
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

## The 12-node-type model

Doco's data model is a graph of typed nodes:

- **Intent** — what someone wants. Source of every downstream Decision.
- **Decision** — a chosen resolution to a question, with alternatives
  weighed. Tied to one or more Intents via \`intent_ids\`.
- **Action** — a designed step in a process (imperative/present verb).
- **Log** — a recorded event that *did* happen (past-tense verb +
  \`happened_at\` + concrete outputs). Immutable once captured.
- **Rule** — an ongoing constraint. Either guidance (agent attention)
  or Doco-node-authoring (capture-gate predicate).
- **Eval** — a named, executable test pinning a load-bearing claim.
- **Reference** — an external pointer (URL, file, doc) with a summary.
- **Scope** — a hashtag-shaped grouping (\`#payments\`, \`#user-flows\`).
- **State** — a node in a formal state machine.
- **Idea** — exploratory capture; promote to Intent / Decision once
  it firms up.
- **Tag**, **Principal** — supporting types.

## Scope onboarding flow (new Doco)

When a Doco is brand new, only the framework-seeded \`#global\` scope
exists. Propose 1–3 project-specific scopes (hashtag-shaped, named
for actual subject areas): \`#payments\`, \`#search\`,
\`#content-schema\`. Confirm with the project owner before they
create them.

For each new scope, walk a population pass: "what's the load-bearing
thing about <area> that's in your head but not in the repo yet?"

## Things only people can do

- GitHub OAuth sign-in.
- Create / delete a Doco.
- Approve OAuth connector installs (when MCP returns).
- Mint human collaboration invites.
`;
