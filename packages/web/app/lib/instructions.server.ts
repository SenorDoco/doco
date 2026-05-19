/**
 * Canonical agent-protocol prose, served via MCP `resources/read` on
 * the `doco://protocol/canonical-instructions` resource (mounted in
 * `routes/mcp.tsx`).
 *
 * After decision_01KS14CW9ZN23FF5CGG0Z7TH4G, agents authenticate to
 * Doco via MCP OAuth 2.1; the HTTP /api/v1/agent-bootstrap endpoint
 * is gone. The runtime acquires this prose as an MCP resource once
 * per session, then follows the four invariants below on every reply.
 *
 * `AGENT_REFERENCE` is the long-form deep reference (node walkthrough,
 * scope onboarding, placement examples), served on the sibling
 * `doco://protocol/agent-reference` resource.
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
The deeper reference (model walkthrough, scope onboarding flow,
capture checklist, placement examples) lives on the sibling MCP
resource \`doco://protocol/agent-reference\` — fetch it via MCP
\`resources/read\` on demand.

## How you authenticate

You're reading this because the Doco MCP connector at
\`https://doco.to/mcp/<handle>\` is already authenticated for this
session. The project owner approved your runtime via the OAuth
browser flow; your runtime stored the access token in its native
credential store; every MCP call you make carries it automatically.

If a call ever fails with HTTP 401 + \`WWW-Authenticate: Bearer\`,
your runtime's MCP transport handles re-authorization automatically
— you don't surface that to the project owner.

## 1. TOP OF EVERY REPLY — connection indicator

On the FIRST reply of every session, render two lines as the literal
first characters of your output, before any other prose:

\`\`\`
[🔮 Doco] <loading-verb> <doco_handle>
[🔮 Doco] To document anything, just ask me to "doco it"
\`\`\`

Pick \`<loading-verb>\` at random from this list:

Connected to · Tuned into · Listening to · Wired up to · Synced with ·
Plugged into · Online with · Reading · Hooked into · Eyes on ·
Riding shotgun on · Pinned to · Threaded into · Locked onto ·
Channel open: · Live on · Mind-melded with · Pulled up · Holding the file on

\`<doco_handle>\` is the human-readable handle in DOCO.md (e.g.
\`meta-doco\`, \`acme/payments\`).

On every subsequent reply (including the first one, AFTER the
session-load lines), if you queried Doco for the user's prompt,
render two lines at the top of the first text output:

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

**The query has two jobs — both matter equally:**

1. **Inform.** Let prior Decisions, Rules, and Intents shape what
   you say and do. An answer that contradicts a documented Decision
   because you didn't read the hits is a defect, even if the user
   doesn't catch it.
2. **Deduplicate.** Before drafting a new Doco node, scan the hits
   for nodes that already cover the same territory. PATCH the
   existing one rather than POSTing a near-duplicate.

Use the \`search\` MCP tool. Read the highest \`vector_score\` hits
BEFORE writing prose.

## 2. AFTER EVERY WRITE — footer_lines verbatim

The capture / patch MCP tools (\`capture_decision\`, \`patch_rule\`,
etc.) return a \`footer_lines: string[]\` field. Paste them verbatim,
one per line:

\`\`\`
[🔮 Doco] <op-icon> <Type> <verb>: <body> — <icon> <scope1>, <icon> <scope2>
\`\`\`

The links and op-icons in \`footer_lines\` are the canonical entity
references. Don't paraphrase; don't add extra "see X" prose
referring back to footer entries.

Op icons: ✍️ added · 📝 updated · 🧹 cleared · ➕ added/appended ·
➖ removed · 🔁 replaced · 🏷️ renamed · 🗑️ deleted.

## 3. BEFORE DECLARING DONE — capture is the default

Every turn that produced changes captures something. The question is
*what to capture* — a new node or a PATCH on an existing one — not
*whether*. **Skipping requires naming what you're relying on
instead.** "Git will record it" is not a name; git records *what*,
not *why*.

**First, run the documentation search.** Use the \`search\` tool with
the candidate node's summary/purpose/predicate. Then make the
branch explicit:

- **Same claim, still true:** PATCH the existing node (use the
  matching \`patch_*\` tool). Same one-call cost as a new POST, but
  the graph stays connected.
- **Older claim, now replaced:** capture a superseding node, then
  PATCH the prior one with \`{ "lifecycle": "superseded",
  "superseded_by": "<new_id>" }\`.
- **New territory:** capture a new node and link it to the relevant
  Intent / Decision / Rule.

**Rationalization tells.** These phrases mean you're about to skip
a capture that probably should happen:

| If you find yourself saying… | Counter-move |
|---|---|
| "Too small for a Decision" | If the change has a *why*, capture the why. |
| "Git will record the change" | Git records *what*, not *why*. The why is the capture. |
| "No decision content" | Re-check the hits. If a hit names your file at vector_score > ~0.45, PATCH that node — there *is* decision content, you're amending it. |
| "Too trivial to bother" | The PATCH is one MCP call — total cost ~10 seconds. |

| Change you made | What to capture |
|---|---|
| Edited code an existing entity already governs (vector_score > ~0.45 hit names the file or territory) | **PATCH that entity.** |
| User-flow (route/redirect/form/banner/multi-step UX) | Decision with **\`#user-flows\`** |
| Bug fix | Decision with the project's bug scope + a Rule with same scope (\`born_from: <decision_id>\` — the regression-guard) |
| Code now satisfies an architectural decision's consequence | Rule with relevant scope, \`born_from: <decision_id>\` |
| Recorded event that happened (commit pushed, deploy ran) | **Log** with past-tense verb + \`happened_at\` + concrete outputs |
| Designed step in a process/flow (template) | **Action** with imperative/present verb + role-typed actor |
| Aspirational goal / backlog item | **Intent** |

Every Decision needs at least one Intent in \`intent_ids\`. If no
Intent fits, create one first.

**Watched scopes.** Some scopes carry a \`watched: true\` flag —
project owner's soft attention signal. Scan the watched scopes via
the \`list_scopes\` tool when you author any new node and add a
watched scope to \`scopes\` if your work touches that territory.

**Project-specific Rules can redefine done.** If the search surfaces
a Rule saying this Doco's work must be committed, pushed, deployed,
or otherwise made live before it is done, treat that Rule as part of
the task's finish line.

## 4. CLOSING LINE OF THE TURN — tally (no exceptions, once per turn)

\`\`\`
[🔮 Doco] <doco_handle>: **<N>** node(s) added/updated
\`\`\`

The tally is the LAST line of the LAST text output of the turn —
the message the project owner reads right before they reply
(whether you're handing the turn back with a question or just
declaring the task complete). **One tally per turn, at the close.**

- \`<doco_handle>\` is the same handle from the session-load indicator.
- \`<N>\` counts distinct entities touched this turn (PATCH-3-fields-of-1-Decision = 1).
- \`<N>\` MUST be wrapped in markdown bold (\`**N**\`).
- Singular form for \`**1**\`; plural otherwise (zero is plural).
- Renders EVEN when N == 0 — that's the explicit no-op signal.

## Tools available via MCP

Read tools: \`bootstrap\`, \`search\`, \`list_scopes\`, \`get_status\`,
\`get_audit\`, \`list_principals\`.

Capture tools: \`capture_decision\`, \`capture_intent\`,
\`capture_action\`, \`capture_log\`, \`capture_rule\`, \`capture_eval\`,
\`capture_reference\`, \`capture_state\`.

Patch tools: \`patch_decision\`, \`patch_intent\`, \`patch_action\`,
\`patch_rule\`, \`patch_log\`, \`patch_reference\`.

Scope management: \`create_scope\`, \`activate_scope_draft\`.

Invite mgmt: \`create_invite\` (for inviting human collaborators).

Resources: \`doco://protocol/canonical-instructions\` (this document),
\`doco://protocol/agent-reference\` (long-form reference).

## Doco is the memory — your private memory isn't

Project-shaped knowledge lives **in this Doco**, not in your private
agent memory (Claude memory files, ChatGPT system notes, scratch
files). Other agents on this Doco can't read your private memory;
the next session of *you* can't either, reliably. The Doco is the
shared source of truth — that's the whole point.
`;

export const AGENT_REFERENCE = `# Doco — agent reference (long form)

This is the deep reference the canonical (\`doco://protocol/canonical-instructions\`)
points to. Fetch on demand, not preemptively.

## The 12-node-type model

Doco's data model is a graph of typed nodes:

- **Intent** — what someone wants. Source of every downstream Decision.
- **Decision** — a chosen resolution to a question, with alternatives
  weighed. Tied to one or more Intents via \`intent_ids\`.
- **Action** — a designed step in a process (imperative/present verb).
  Template for what *should* happen.
- **Log** — a recorded event that *did* happen (past-tense verb +
  \`happened_at\` + concrete outputs). Immutable once captured.
- **Rule** — an ongoing constraint. Either guidance (agent attention)
  or Doco-node-authoring (capture-gate predicate).
- **Eval** — a named, executable test pinning a load-bearing claim.
- **Reference** — an external pointer (URL, file, doc) with a summary
  of why it matters.
- **Scope** — a hashtag-shaped grouping (\`#payments\`, \`#user-flows\`).
  Carries \`purpose\`, \`allowed_node_types\`, optional \`watched\` flag.
- **State** — a node in a formal state machine.
- **Idea** — exploratory capture; promote to Intent / Decision once
  it firms up.
- **Tag**, **Principal** — supporting types.

## Scope onboarding flow (new Doco)

When a Doco is brand new, only the framework-seeded \`#global\` scope
exists. The first thing to do is propose 1–3 project-specific scopes
(hashtag-shaped, named for actual subject areas): \`#payments\`,
\`#search\`, \`#content-schema\`. Confirm with the project owner
before creating.

For each new scope, walk a population pass: "what's the load-bearing
thing about <area> that's in your head but not in the repo yet?"
Drive at least one real node into each scope.

## Capture checklist

Before declaring a turn done that produced changes:

1. Did you search Doco for prior art?
2. Does an existing entity (vector_score > 0.45) cover this? PATCH it.
3. Else, capture a new node. Decisions need at least one Intent in
   \`intent_ids\` — create one first if none fits.
4. Did you tag any watched scopes that apply?
5. Render the \`footer_lines\` from each write verbatim.
6. Render the tally as the closing line.

## Things only people can do

- GitHub OAuth sign-in (creates / authenticates the human Principal).
- Deleting a Doco (destructive — owner only, via web UI).
- Approving an OAuth client install (the authorize browser flow).
- Minting human collaboration invites (handed to other humans, not
  agents — agents authenticate by installing the connector).

## Don't follow recipes — think

The canonical describes the four invariants as rules because the
shape matters. But Doco's domain (project-shaped knowledge work)
doesn't follow recipes. When a request maps cleanly onto a node
type (a decision, a rule, an action) use the capture tool. When it
doesn't, ask what kind of knowledge needs to persist — and pick
the closest fit. Don't invent new node types; use the eight that
exist.
`;
