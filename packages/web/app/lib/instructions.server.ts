/**
 * Canonical agent-bootstrap instructions — split into two exports.
 *
 * `CANONICAL_INSTRUCTIONS` is the slim daily-use bootstrap (~1,200 tokens)
 * served on every `GET /api/v1/agent-bootstrap`. It covers ONLY the
 * protocol mechanics — the four invariants every reply must follow —
 * so agents have low-overhead bootstrap on every session.
 *
 * `AGENT_REFERENCE` is the long-form deep reference (the model
 * walkthrough, scope onboarding, "don't follow recipes — think"
 * principles, placement examples, the icon dictionary, the "Doco is the
 * memory" rule, the claim flow). Served at `GET /api/v1/agent-reference`
 * and fetched on demand when the agent hits an edge case or needs more
 * detail than the canonical carries.
 *
 * The split exists because the previous monolithic canonical (~7,400
 * tokens) caused agents to chunk-read 4× per session, re-fetch from
 * scratch out of mistrust, and still miss the protocol mechanics. The
 * slim version makes the dial-tone unmissable and the reference
 * available when actually needed.
 *
 * Per ADR-080 (centralized bootstrap), ADR-082 (scopes carry purpose +
 * guidelines), ADR-086 (knowledge lives in Doco, not private memory),
 * and the `slim-canonical-and-agent-reference-split` Decision (this
 * commit).
 */

export const CANONICAL_INSTRUCTIONS = `# Doco — agent bootstrap (slim)

You're working on a project that uses **Doco** — AI-native documentation
of intent, decisions, rules, actions. Every meaningful
decision leaves a trail.

This document carries the **four invariants** every reply must follow.
For deeper reference (model walkthrough, scope onboarding flow, capture
checklist, "don't follow recipes — think" principles, placement
examples), fetch \`https://doco.to/api/v1/agent-reference\` on demand.

## 1. TOP OF EVERY REPLY — connection indicator

Only render the regular Doco indicator when you have proper access:
\`DOCO_ID\` is present, \`DOCO_TOKEN\` is present, the bootstrap for
\`https://doco.to/api/v1/agent-bootstrap?id=$DOCO_ID\` returns this
Doco's per-Doco context without an access warning, and the per-prompt
search endpoint is reachable with the same token.

If any of that is missing or failing, render exactly one Doco line at
the top of every reply and do not render query/count/tally/footer lines:

\`\`\`
[🔮 Doco] Not connected yet: <reason>
\`\`\`

Pick the concrete reason that matches what actually failed (do not
invent or paraphrase — agents that compose generic reasons produce
generic recovery advice and waste the project owner's time). The
recovery action depends on WHICH failure mode you hit.

**Before consulting the table — verify your bearer was actually sent.**
Prefer the CLI wrappers when you are fetching Doco from a shell:
\`doco bootstrap\` for the canonical and \`doco search "<task>"\` for
the per-prompt query. They read \`DOCO_TOKEN\` from \`./.env\` inside the
process, so the bearer token never appears in shell command text or
permission prompts. If your runtime falls back to raw shell
\`curl ... -H "Authorization: Bearer $DOCO_TOKEN"\`, the \`./.env\`
fallback documented in §Authentication does NOT apply: shell expansion
only sees variables already in the environment, and an empty
\`$DOCO_TOKEN\` gets sent as \`Authorization: Bearer \` (empty bearer).
The host then correctly returns \`token cannot access this Doco\` — but
the fix is to load \`./.env\` (\`set -a; . ./.env; set +a\`) and re-curl,
not to ask the project owner to re-authorize. Run
\`[ -n "$DOCO_TOKEN" ] && echo set || echo unset\` before recommending
any recovery below. Misdiagnosing an empty-bearer as a membership gap
and routing the project owner to \`doco login\` (or worse,
\`doco login --create\`) is the exact reflex this rule prevents — the
token on disk is fine; the shell just never picked it up.

| Disconnected reason | Recovery to recommend to the project owner |
|---|---|
| \`missing DOCO_TOKEN\` | \`doco login --host https://doco.to\` mints a fresh token. |
| \`authorization expired\` / 401 from bootstrap | Same — \`doco login --host https://doco.to\`. |
| \`missing DOCO_ID\` | Edit the **This project's Doco ID** line in \`AGENTS.md\` (or re-run \`doco login\` — it stamps the id at the top of the file). |
| \`token cannot access this Doco\` / 403 from bootstrap | Ask the project owner to add this agent as a member of the Doco, OR run \`doco login\` with an account that already has access. **Do NOT recommend \`doco login --create\` — that would fork a duplicate Doco.** |
| \`Doco doesn't exist on this host\` / 404 from bootstrap | Read the bootstrap response's \`missing_doco_guidance\` field (added when this case hits) — it carries the right action for both subcases (create-new with \`doco login --create <slug>\` OR fix a stale id in AGENTS.md). |
| \`bootstrap fetch blocked\` / \`HTTP_STATUS:000\` / \`doco.to unreachable\` | **Sandbox / network-policy issue — \`doco login\` will NOT help here.** The bearer token is fine; the request never left your agent runtime. Tell the project owner to allowlist \`doco.to\` in your agent's network/sandbox settings (Codex web, GitHub Coding Agent, Anthropic web sandbox, etc. each have their own settings page). For a one-off, ask approval for \`doco bootstrap\` / \`doco search\` rather than a raw curl command that exposes the bearer token in the prompt. |
| Host returns 5xx | doco.to is down; wait + retry. \`doco login\` won't help. |

When you can't tell which case applies, surface the raw HTTP status +
the host's response body in the disconnected indicator and let the
project owner choose — never default to \`doco login\` because it's
the most familiar suggestion. A wrong recovery move (mint a fresh
token to fix a sandbox-block; \`--create\` a duplicate Doco to fix a
membership gap) is strictly worse than a clear "I don't know which —
here's what failed."

When you are connected, the regular indicator splits across two
lifecycle moments — **session-load** (fires once when you read this
canonical) and **per-reply** (fires every turn). On your FIRST reply of
a session you emit both; on later replies, just the per-reply piece.

### 1a. Once per session — the moment you recognize this is a Doco project

The session-load indicator is the **literal first characters** of your
first reply in the session. Before any prose. Before any narration like
"I'll fetch the canonical" or "let me read the bootstrap." Before any
tool call beyond loading \`./.env\`. The line *itself* is how you
acknowledge "I see this is a Doco project" — the canonical fetch comes
next, narrated AFTER the line, not before.

You know it's a connected Doco project the moment the SessionStart hook
injected a \`🔒 Doco canonical_instructions\` block with no warning, or
a manual bootstrap fetch using \`DOCO_ID\` + \`DOCO_TOKEN\` returned this
Doco's per-Doco context. You do **not** need to have finished reading
the canonical body — you have \`$DOCO_ID\`, that is enough to render:

\`\`\`
[🔮 Doco] <loading-verb> <doco_id>
\`\`\`

The failure mode this rule prevents: agent narrates "I have the
canonical, now let me query Doco," runs three tool calls, *then*
finally emits the connection line at line 12 of its reply. The project
owner sees ten seconds of generic prose before the visual signal that
the Doco protocol is engaged. Reverse it — line is first, prose is
second.

Don't repeat the session-load line on subsequent replies in the same
session — once is enough. If you re-fetch the canonical mid-session
(host blip, lost context, manual curl after a warning), emit it again
to signal the reconnection.

**Pick \`<loading-verb>\` at random from this list — zero deliberation, no tone-matching to the prompt:**

Connected to · Tuned into · Listening to · Wired up to · Synced with ·
Plugged into · Online with · Reading · Hooked into · Eyes on ·
Riding shotgun on · Pinned to · Threaded into · Locked onto ·
Channel open: · Live on · Mind-melded with · Pulled up · Holding the file on

When the SessionStart hook pre-builds this line (Claude Code), the
verb is already randomized **and the line itself is in the wrapper
above the canonical** — emit it verbatim as your first output instead
of re-picking the verb or waiting until you've read the canonical body.

### 1b. Per turn — at the top of the turn's FIRST text output

Two lines if you queried, nothing at all if you didn't. Render BEFORE
any prose in the FIRST text output of the turn (and after the
session-load line on your first reply):

\`\`\`
[🔮 Doco] <querying-verb>
[🔮 Doco] <N> relevant nodes found (<X.X>s)
\`\`\`

If you didn't need to query (greeting, one-word ack), emit nothing at
the top — no "Not querying" placeholder, no fallback line. Absence is
the signal.

A "turn" is one user prompt → your complete answer, even when that
answer threads multiple text outputs through tool calls. The query
indicator goes at the very top of the FIRST text output of the turn —
once. Intermediate progress updates between tool calls ("found the
file, editing now," "typecheck passed, capturing rationale") are plain
prose with no indicator and no tally. Don't restart the indicator on
each chunk; the project owner reads the whole turn as one reply, and
repeating bookends on every chunk turns the protocol into visual noise
instead of a dial-tone.

**Pick \`<querying-verb>\` at random from this list — same rule:**

Querying... · Looking it up... · Asking around... · Reading the room... ·
Sniffing for hits... · Flipping through notes... · Scanning the graph... ·
Searching the lore... · Peering into the orb... · Combing the archive... ·
Hunting for prior art... · Pinging the memory... · Cross-referencing... ·
Checking what's known... · Tracing the trail... · Diving in... ·
Polling the Doco... · Skimming the index... · Asking the oracle... · Searching...

The structured fields (count, timing) appear identically every reply — only the verb varies. Pick fast and move on. When the UserPromptSubmit hook pre-builds the indicator block (Claude Code), the verbs are already randomized there — emit verbatim instead of re-picking.

The query. Prefer the CLI wrapper when available because it keeps the
bearer token out of shell command text:

\`\`\`
doco search "<paraphrase-of-task>"

# HTTP fallback if the CLI is unavailable:
GET https://doco.to/by-id/<doco_id>/search.json?q=<paraphrase-of-task>
\`\`\`

Response carries \`count\`, \`duration_ms\`, and \`hits[]\` ordered by
\`vector_score\` descending. Each hit includes \`id\` (the entity's ULID,
e.g. \`decision_01KRHB95AVGFHG80B2EAWE20K8\`), \`summary\`,
\`vector_score\` (cosine similarity 0..1, the ranker), and \`gpr\`
(Global PageRank, a secondary centrality signal). Scope hits also
carry \`name\` (the short readable handle scopes are referenced by).
Storage is Postgres — entities don't have a stable on-disk location to
read; fetch the body with
\`GET https://doco.to/by-id/<doco_id>/api/<type-plural>/<id>.json\`
(e.g. \`/api/decisions/decision_01K....json\`,
\`/api/intents/intent_01K....json\`) when you need the full text. Plurals
match the POST endpoints listed in §3 below. Search is vector-only — one cosine
ranking, no FTS card, no find-rules sidecar. Read the
highest-vector_score hits BEFORE writing prose. Don't \`grep\` the repo
for context that Doco already indexes.

**The query has two jobs — both matter equally:**

1. **Inform.** Let prior Decisions, Rules, and Intents shape what you
   say and do. Doco's premise is that nothing important is forgotten;
   you're standing on a paper trail — use it. An answer that
   contradicts a documented Decision because you didn't read the hits
   is a defect, even if the user doesn't catch it.
2. **Deduplicate.** Before drafting a new Doco node, scan the hits
   for nodes that already cover the same territory. If a hit is the
   same claim and still true, **PATCH it** (extend it, add context)
   rather than POSTing a near-duplicate. If a hit is the older claim
   your new claim replaces, capture the new node as a supersession and
   mark/link the prior one as superseded. Two overlapping nodes are
   strictly worse than one stale one — they fragment the graph and
   force every future agent to pick which is canonical. New nodes are
   for new territory.

If \`OPENAI_API_KEY\` isn't set on the host, the response carries
\`hits: []\` plus a \`warning\` field explaining vector search is
unavailable — handle that as "0 relevant nodes found" in the indicator.

## 2. AFTER EVERY WRITE — footer_lines verbatim

POST/PATCH/DELETE on any \`/api/*.json\` returns \`footer_lines: string[]\`.
Paste them verbatim, one per line:

\`\`\`
[🔮 Doco] <op-icon> <Type> <verb>: <body> — <icon> <scope1>, <icon> <scope2>
\`\`\`

- For \`added\` ops, \`<body>\` is \`[<summary>](<url>)\` — the entity's
  summary is itself the markdown link. The user reads and clicks
  readable prose; the ULID lives in the URL.
- For mutations on an existing entity (\`updated\`, \`renamed\`, …),
  \`<body>\` is also \`[<summary>](<url>).<field> <change>\` — same link
  shape as \`added\`, with the field change appended.
- The scope tail (\` — <icon> <scope1>, <icon> <scope2>\`) is omitted
  when the node has no scopes.
- Multi-op batches emit one line per op; the LAST line carries
  \` (X.Xs)\` timing AFTER the scope tail — already in the response.
- Running the write command is not enough. If the tool output returned
  two \`footer_lines\`, the user-facing reply must show two Doco operation
  lines before the closing tally. The tally is only the aggregate
  bookend; it never substitutes for the per-operation lines.

Op icons: ✍️ added · 📝 updated · 🧹 cleared · ➕ added/appended ·
➖ removed · 🔁 replaced · 🏷️ renamed · 🗑️ deleted.

## 3. BEFORE DECLARING DONE — capture is the default

Every turn that produced changes captures something. The question is
*what to capture* — a new node or a PATCH on an existing one — not
*whether*. **Skipping requires naming what you're relying on instead.**
"Git will record it" is not a name; ADR-086 is exactly this trap (git
records *what*, not *why*).

**First, run the documentation search.** The top-of-reply query may be
broader than the node you're about to write. Once you decide a capture
is needed, search Doco again with the candidate node's
summary/question/predicate. Read the highest-vector_score hits, then
make the branch explicit:

- **Same claim, still true:** PATCH the existing node with
  \`doco patch <type> <id> --append-body "..."\` — same one-liner cost
  as a new POST, but the graph stays connected.
- **Older claim, now replaced:** capture a superseding node and
  transition/link the prior one (\`doco supersede <decision_id>\` for
  Decisions, or \`doco patch <type> <id> --lifecycle superseded
  --superseded-by <new_id>\` where supported).
- **New territory:** POST a new node and link it to the relevant
  Intent, Decision, or Rule.

If an existing entity already covers your change (a search hit names
the file or the territory at vector_score > ~0.45), PATCH or
supersede it. New nodes without a supersession edge are for genuinely
new territory.

**Rationalization tells.** These phrases mean you're about to skip a
capture that probably should happen. Each binds to a counter-move:

| If you find yourself saying… | Counter-move |
|---|---|
| "The CLI doesn't support capturing X" | Use \`doco capture action\` / \`rule\` / \`eval\` — they're all CLI-native. If a node type really lacks CLI support, hand-write the YAML; CLI gaps are not a node-shape decision. |
| "Too small for a Decision" | If the change has a *why*, capture the why. A 2-line removal can encode a real choice — rejected alternatives, weighed trade-offs, an affordance that's now redundant. |
| "Git will record the change" | Git records *what*, not *why*. The why is exactly what makes the capture worth writing. |
| "No decision content" | Re-check the hits. If a search result names your file or your territory at vector_score > ~0.45, **PATCH that node** — there *is* decision content, you're amending it. |
| "Too trivial to bother" | The PATCH is one line: \`doco patch decision <id> --append-body "Update YYYY-MM-DD: <what + why>."\` — total cost ~10 seconds. The cost asymmetry that justified skipping is gone. |

Scope names below are bare (no \`scope_\` prefix) and match the default
templates installed by \`doco init\`. If a referenced scope isn't
installed in this Doco yet, create it at \`https://doco.to/by-id/<doco_id>/scopes/new\`
first.

**Watched scopes** (ADR-137bis). Some scopes carry a \`watched: true\`
flag — a soft attention signal saying "contributors should proactively
look for opportunities to document into this scope." It's NOT
enforcement: nothing rejects a capture that omits a watched scope.
It's a prompt for you, the agent. Two rules:

1. When you author ANY new node (Decision, Intent, Action, Rule, Eval,
   Reference, …), scan the watched scopes for this Doco —
   they appear in the bootstrap response, in \`/status.json\`, and on
   the per-scope manifest with \`is_watched: true\`. Ask: "does my
   work touch any of these topics?" If yes, include that scope in the
   new node's \`scopes\` list alongside the subject-area scope you'd
   have picked anyway. A watched scope is rarely the *only* scope a
   node belongs to — it stacks.

2. When the user describes work that lands on a watched scope and you
   were about to capture without tagging it, pause and add the scope.
   "Watched" is the project owner's way of saying "I keep wanting to
   know how this is going" — silently leaving it off is the failure
   mode the flag exists to prevent.

Distinguish from \`mandatory_scope\` authoring rules on the Global scope (the doco's constitution): those are
hard-enforced (capture is rejected if the scope isn't listed). Watched
is soft. A scope can be one, both, or neither.

**Informing the project owner about scopes** (Global scope: scope-manifest visibility).
The scope manifest — every scope this Doco carries and which of them
sit under the \`watched\` flag — is how the project owner steers what
this Doco pays attention to. The manifest only stays useful if the
project owner can see it whole and keeps shaping it. Two rules:

1. When you start work on this Doco — and again whenever the
   conversation pivots into territory you haven't touched yet —
   surface the manifest in plain prose: name each scope, note its
   purpose, and call out which carry the \`watched\` flag. Don't bury
   this in a tool call or assume the project owner still remembers
   what they set up weeks ago. Re-introducing the manifest is part
   of the work, not a side errand.

2. When the manifest drifts from reality — a watched scope hasn't
   accrued activity in weeks, a new line of work has no scope of its
   own, a scope's stated purpose no longer matches what's in it —
   say so to the project owner. Only they can abandon, sharpen, or
   add scopes; your job is to make sure they have the signal in
   time to act on it. Watched scopes are the project owner's
   standing request to "keep me posted on this," and that request
   only holds value while the watched set still reflects what they
   actually care about.

Like the watched-scopes prompt above, this rule isn't a per-node
predicate the engine checks — it shapes the rhythm of the
collaboration itself. It lives in the Global scope (the doco's constitution) because the
manifest is load-bearing for every other decision the project owner
makes about this Doco.

**When a request sounds like a standing rule** (Global scope: durable defaults).
When the project owner asks an agent to do something "all the time",
"always", "from now on", "in every session", "across all sessions", or
for every future agent, treat that as a signal that the preference may
belong in the Global scope as a Rule. Suggest it explicitly: "That
sounds like a Doco-wide rule; would you like me to add it to the Global
scope?" Name the candidate predicate in plain language so the project
owner can confirm, refine, or decline it.

Do not silently turn every preference into a Global Rule. The point is
to protect durable, cross-session intent from staying trapped in one
conversation. The project owner still decides whether the instruction
is a one-off, a local convention, or a Doco-wide invariant.

**Project-specific Rules can redefine done.** If bootstrap or search
surfaces a Rule saying this Doco's work must be committed, pushed,
deployed, smoke-tested, linked, or otherwise made live before it is
done, treat that Rule as part of the task's finish line. Execute it
before the final reply, or state the exact blocker that prevented it.
Do not answer as though the local edit is complete while a known Rule
still requires a push, deploy, live check, or other release step; do
not wait for the project owner to repeat a standing Rule that Doco has
already returned to you.

When a Rule says "done means live", the final reply needs evidence:
the commit or branch that moved, the deployment target or URL, and the
verification that the live target reached the expected state. Sandbox
or permission failures are blockers to surface, not reasons to
rationalize skipping the Rule.

| Change you made | What to capture |
|---|---|
| **Edited code an existing entity already governs** (vector_score > ~0.45 hit names the file or the territory) | **PATCH that entity** with \`doco patch <type> <id> --append-body "..."\`. Don't open a sibling node — the existing one tracks the same element's reasoning over time. |
| User-flow (route/redirect/form/banner/multi-step UX) | Decision with **\`user-flows\`** |
| UI affordance / element copy / interaction tweak (not the journey itself) | Decision with the project's design-language scope (if one exists) — or, if a governing Decision exists, **PATCH it** (see top row). |
| Bug fix | Decision with the project's bug scope + a Rule with the same scope (\`born_from: <decision_id>\` — the link IS the regression-guard) |
| Code now satisfies an architectural decision's consequence | Rule with the relevant subject-area scope, \`born_from: <decision_id>\`. |
| Editing the framework itself (CLI templates, hooks, bootstrap pipeline, canonical) | tag the project's framework scope (if one exists) on top of whatever else applies |
| Did real work that doesn't fit above | Action with the verb + outputs + subject-area scope(s) |

**On ADRs.** Doco has no native ADR concept. The framework doesn't
auto-assign numbers, doesn't auto-add an \`adrs\` scope, doesn't have
an \`is_adr\` flag, doesn't have a \`number\` field on Decision. If a
project wants to track ADRs, it authors an \`adrs\` scope as a
custom scope (the framework no longer ships an ADR template) — that
scope's guidance Rules describe whatever convention the project picks
(sequential \`ADR-NNN\`, git-commit-hash, or whatever). The identifier
lives in the Decision's body or summary; the framework treats it as
plain prose.

Every Decision needs at least one Intent in \`intent_ids\`. If no
Intent fits, create one first (\`doco capture intent …\`).

Don't hand-write YAML. **Prefer the \`doco capture\` CLI** — one bash
invocation per node, no curl, no Authorization header, no URL
construction. It reads \`DOCO_TOKEN\` from the environment (or
\`./.env\`) and \`DOCO_ID\` from the AGENTS.md header in the current
directory, talks to \`https://doco.to\`, and prints
the response's \`footer_lines\` to stdout for you to paste verbatim:

\`\`\`
# Create new nodes:
doco capture intent    --summary "..." --scope <comma,list>
doco capture decision  --question "..." --chosen "..." --scope <comma,list>
doco capture action    --summary "..." --verb "<verb>" --scope <comma,list>
doco capture rule      --summary "..." --predicate "..." --scope <comma,list>
doco capture eval      --name "..." --scope <comma,list> --criterion-kind exact|shape|llm-judge

# Extend an existing node (the move that beats "skip-and-rationalize"):
doco patch <type> <id> --append-body "..." [--summary "..."] [--scope <comma,list>]
\`\`\`

Each subcommand accepts \`--body-md\` (inline) or \`--body-md-file\`
(path) and type-specific optional fields (\`--intent-id a,b\`,
\`--alternatives <JSON>\`, \`--decided-by-username\`, etc.). Run
\`doco capture <type> --help\` or \`doco patch <type> --help\` for the
full flag set. The \`doco patch\` command is the **single biggest unlock
against capture-skip rationalization** — it makes "extend the existing
entity" exactly as cheap as "POST a new one."

The CLI exists specifically so agents don't have to issue
state-mutating curl POSTs, which conservative permission systems
(Claude Code's auto-mode classifier, etc.) reject by default — a
single \`Bash(doco:*)\` allowlist entry unblocks every capture
operation, where allowlisting curl would mean enumerating every
endpoint and flag shape.

If \`doco\` isn't on \`$PATH\` (fresh agent, no install), fall back to
the raw HTTP endpoints — same auth, same response shape:

\`\`\`
POST  https://doco.to/by-id/<doco_id>/api/decisions.json
POST  https://doco.to/by-id/<doco_id>/api/intents.json
POST  https://doco.to/by-id/<doco_id>/api/actions.json
POST  https://doco.to/by-id/<doco_id>/api/rules.json
POST  https://doco.to/by-id/<doco_id>/api/evals.json
PATCH https://doco.to/by-id/<doco_id>/api/decisions/<id>.json   (and same for other types — pass \`body_md_append\` to extend the body)
\`\`\`

Full request specs: \`GET https://doco.to/by-id/<doco_id>/api/<type>.txt\`. The
server resolves names → ids, generates the ULID, writes the file, and
reindexes — one round-trip whether you use the CLI or curl.

## 4. CLOSING LINE OF THE TURN — tally (no exceptions, once per turn)

\`\`\`
[🔮 Doco] <doco_id>: **<N>** node(s) added/updated
\`\`\`

The tally is the LAST line of the LAST text output of the turn — the
message the project owner reads right before they reply (whether
you're handing the turn back with a question or just declaring the
task complete). **One tally per turn, at the close.** Never on
intermediate progress updates between tool calls; those are plain
prose with no tally and no top-of-reply indicator. Stacking a tally
on every intermediate chunk turns the protocol into clutter instead
of an end-of-turn dial-tone.

- \`<doco_id>\` from the project's AGENTS.md header (or \`process.env.DOCO_ID\`).
- \`<N>\` counts distinct entities touched this turn (PATCH-3-fields-of-1-Decision = 1).
- \`<N>\` MUST be wrapped in markdown bold (\`**N**\`).
- Singular form for \`**1**\`; plural otherwise (zero is plural).
- Renders EVEN when N == 0 — that's the explicit no-op signal.

## Authentication

Two values, two homes — split by whether they're secret:

- \`DOCO_TOKEN\` — bearer; **secret**; gates writes. Lives in
  \`./.env\` (gitignored). Read from \`process.env\` first, then from
  \`./.env\` as a fallback.
- \`DOCO_ID\` — \`doco_...\`; **non-secret** coordinator (like a repo
  slug). Lives at the top of \`AGENTS.md\` on a line shaped
  \`**This project's Doco ID:** \\\`doco_...\\\`\`. Read from
  \`process.env\` first, then grep \`AGENTS.md\` (or \`CLAUDE.md\`) for
  the first \`doco_<ulid>\` match. Legacy repos that still carry
  \`DOCO_ID\` in \`.env\` keep working: the env load wins over the
  AGENTS.md fallback.

Missing or unauthorized → do not ask the user to paste a token. Ask
them to authorize the agent with the browser flow:
\`doco login --host https://doco.to\`. If this is a new Doco, use
\`doco login --host https://doco.to --create <slug>\`. \`doco login\`
writes \`DOCO_TOKEN\` to \`./.env\` and stamps \`DOCO_ID\` into
\`AGENTS.md\` in one step.

For shell-based reads, prefer \`doco bootstrap\` and \`doco search\`
over raw \`curl -H "Authorization: Bearer $DOCO_TOKEN"\`; the CLI loads
the same credentials internally without exposing the bearer token in
shell history or agent permission prompts.

## Auto-loaded protocol (Claude Code only)

\`.claude/settings.json\` wires four hooks:

- **\`SessionStart\`** — fetches this document at session start; injects
  as additional context.
- **\`UserPromptSubmit\`** — re-injects a tight checklist AND pre-fetches
  \`/search.json\` for the prompt on every user message.
- **\`PostToolUse\`** (on Edit/Write) — cross-references the edited path
  against the prompt's pre-fetched search hits. If a Decision with
  vector_score > ~0.45 names this file, injects a *"governed by
  [decision_X] — consider PATCHing"* hint. Catches drift while it's
  still in flight.
- **\`Stop\`** — if the session shows Edits/Writes > 0 and zero
  \`doco capture\` calls, injects a final *"about to declare done with
  edits but no captures — name the existing node or capture."* It also
  compares footer lines printed by Doco write tools against footer lines
  pasted into assistant text, and nudges when the write succeeded but
  the per-operation lines never reached the user. The last line of
  defense against silent skip and silent footer drops.

If you see those blocks already at the top of your context, the hooks
worked — **do NOT re-fetch via curl**. Re-read the block already loaded.

Non-Claude-Code agents: run \`doco bootstrap\` manually at the start of
each new task.

## If the bootstrap fetch fails — refuse to proceed

If the SessionStart hook injected a "⚠️ Doco bootstrap not loaded"
warning instead of \`canonical_instructions\`, or a manual
\`doco bootstrap\` (or raw curl fallback) returns nothing / non-200
(host down, network error, expired token, wrong \`DOCO_ID\`),
**stop**. Do not start the user's task — not a typo fix, not a
one-line edit, not even a question that doesn't touch code. There
is no "continue without Doco" option: the protocol (query indicator,
captures, footer, tally) is the contract you owe the project owner
on every reply, and none of it works without the host.

Tell the user, in plain prose, exactly what failed (host
unreachable, 401, expired token, missing env var) and what you
need to reconnect (start the host, fix \`.env\`, refresh the
token). Then **wait**. Don't propose alternatives, don't offer to
proceed anyway, don't ask which path they prefer. When they
confirm the fix, re-curl. Only when the bootstrap loads
successfully do you begin the work.

Silently degrading — or worse, asking permission to silently
degrade — hides exactly the friction the project owner needs to
see. Surface it and wait it out.

## What's NOT in this slim canonical

The deeper reference lives at \`GET https://doco.to/api/v1/agent-reference\`:

- The 12-node-type model walkthrough
- Scope onboarding flow ("decide-and-confirm, not decide-and-execute")
- "Don't follow recipes — think" principle (mapping domain practices to Doco primitives)
- Placement examples (whole-message shapes for question / informational / no-writes / conversational replies)
- Things only people can do
- Creating a Doco from a CLI session (\`doco login --create\`, browser-authorize flow)
- ADR-086: "Doco is the memory — your private memory isn't"

Fetch the reference when you hit any of those edges. For 80% of work,
the four invariants above are everything you need.
`;

// ─── Long-form reference (served at /api/v1/agent-reference) ─────────────

export const AGENT_REFERENCE = `# Doco — agent reference (long form)

This is the deeper reference, fetched on demand from
\`GET https://doco.to/api/v1/agent-reference\`. The slim bootstrap
(\`/api/v1/agent-bootstrap\`) carries the four invariants you apply on
every reply; this document is for when you hit an edge case — scope
onboarding, the claim flow, a methodology question, placement
ambiguity.

## When you've just created a Doco — scopes come next

A new Doco has the framework-seeded **Global scope** (always installed,
serves as the doco's constitution) and zero project-specific scopes.
Nodes outside Global can't be added until at least one project-specific
scope exists (the connectivity lint enforces this). The framework ships
one additional opt-in template — **\`user-flows\`** — for the common
case where end-to-end journeys matter. Every other scope a project
wants (\`adrs\`, \`apis\`, \`bugs\`, \`runbooks\`, \`post-mortems\`,
\`glossary\`, \`roadmap\`, \`design-language\`, \`coding-style\`,
\`framework\`, \`test-evals\`, anything else) is **project-owner-authored**
— you propose, the owner customs them.

Onboarding has **two steps**, in this order. Stopping after step 1 is
the single most common onboarding failure mode — agents create the
scope shells, print "onboarding done", and walk away leaving empty
containers. Don't.

### Step 1 — propose and materialize scopes (decide-and-confirm)

Your job here is **decide-and-confirm, not decide-and-execute**.
Propose, then **wait for the project owner's nod before materializing.**

1. **Read the project.** Files in the repo, README, the description
   the project owner gave at wizard time. If you have enough signal
   to propose with confidence, go to step 2. **If you don't, go to
   step 3 (ASK is the default for low-context docos).**
2. **Propose the curated starter set** in plain prose. The
   recommended starter shape is **\`user-flows\` (from the template)
   + 1–3 custom scopes** named for the project's actual subject
   areas. Everything other than \`user-flows\` is project-owner-authored
   — you describe a custom scope's purpose + initial rules in the
   propose-and-confirm step, then the owner sees and tweaks them.
   Phrasing:
   > "For this project I'd start with **user-flows** (end-to-end
   > journeys, from the template), plus custom scopes
   > **\`<project-area>\`** for <reason> and **\`<other-area>\`**
   > for <reason>. Sound right, or do you want me to adjust?"
   Then **stop and wait.** Do not call \`/scopes/new\` until the
   project owner has acknowledged.
3. **If the project is unclear, ASK first.** Don't guess.
   > "Before I set up scopes — what areas of this project do you
   > want to track separately? I'd start you with \`user-flows\`
   > plus 1–3 custom scopes named for the project's subject areas
   > (e.g. \`payments\`, \`search\`)."
4. **Default watched=true during onboarding.** Every scope you
   create in this onboarding session passes \`watched: true\` to
   the scope-creation endpoint. The project owner is literally in
   the room picking these scopes on purpose — the soft attention
   signal is exactly what onboarding is for. ADR-137bis's "no
   silent default" rule applies again *after* onboarding; new
   scopes added later require an explicit choice on every surface.
   The project owner can flip any scope's watched value any time
   from the scope's edit page. **Explain "watched" to the project
   owner the first time you mention it**, in their words:
   > "Watched means: when you (or an agent) capture work later,
   > this scope nudges you to consider whether the work belongs
   > here. It's a soft signal — not enforcement. Onboarding scopes
   > default to watched; you can flip any of them from the scope's
   > edit page later."
5. Only after the project owner confirms do you POST to
   \`https://doco.to/by-id/<doco_id>/scopes/new\` (or call the
   scope-creation endpoints). Children require their parent to
   already exist.
6. **A single template scope is a smell.** "I set up \`user-flows\`"
   alone means you didn't engage with what the project is about.
   Add at least one **custom** scope named for a project-specific
   subject area alongside any template scope.

### Step 2 — drive real content into each scope (don't stop at shells)

**ONBOARDING IS NOT DONE WHEN SCOPES EXIST.** A scope without nodes
is documentation theater — a directory of empty rooms. For EACH
scope you just created, ask the project owner what they want to
capture first. Concrete asks beat generic ones:

- For \`adrs\` → "What's the most important architectural choice
  you've already made that should be the first ADR?"
- For \`user-flows\` → "Walk me through the most important user
  journey in this project — I'll capture it as an Intent plus an
  Action chain."
- For a custom subject-area scope (e.g. \`payments\`,
  \`content-schema\`) → "What's the load-bearing thing about
  <area> that's in your head but not in the repo yet?"

Drive at least one real node into each scope. Only stop when
EITHER:

- (a) each scope has at least one real node, OR
- (b) the project owner explicitly says "defer the rest for now."
  Acknowledge their choice: "OK, deferring; remember
  \`<scope_a>\`, \`<scope_b>\` are still empty and would benefit
  from a real node when you have a minute."

**Never print "onboarding done" if any scope is still empty unless
(b) was said.** Empty scopes are the failure mode this step exists
to prevent.

## The model in 30 seconds

Twelve node types. Files at \`<plural>/<id>.md\` (or \`.yaml\`).

| type | what it captures |
|---|---|
| doco | the Doco itself |
| principal | a user (person or agent) |
| organization | a group of principals |
| intent | what someone wants — the source of all downstream work |
| idea | speculative thought, before it crystallizes |
| rule | invariant the framework enforces |
| decision | an ADR — why a choice was made |
| action | a thing that was done |
| eval | named, executable test/eval pinning a load-bearing claim |
| reference | external source |
| **scope** | **a topical neighborhood** — the navigation primitive |

**Scopes are how large Docos stay navigable.** A scope can be anything
you want to track separately — a feature area, a country, a team, a
customer segment, a regulatory regime, a document type, a migration
project. Pick names that make sense for what *this* Doco is about.
The framework ships two opinionated templates (\`global\` and
\`user-flows\`); common conventions like \`adrs\`, \`apis\`, \`bugs\`,
\`runbooks\`, \`post-mortems\`, \`glossary\`, \`roadmap\`,
\`design-language\`, \`coding-style\`, \`framework\`, \`test-evals\` are
no longer auto-installed and are project-owner-authored when needed.

Any node belongs to one or more scopes. **Scopes are
edge-hierarchical:** a child scope's parents live in its \`scopes\`
field, not in slashes in its name. So \`country/france/payment\` is
three scopes — \`country\`, \`france\` (with \`scopes: [country.id]\`),
\`payment\` (with \`scopes: [france.id]\`) — not a single string.

Assign at least one scope to every Decision, Action, Idea, and Intent
(the connectivity lint enforces this).

**\`follows\`** orders entities into BPMN-style flows: \`B follows: [A]\`
means A came first. Cycles are caught by lint.

## Don't follow recipes — think

When the user asks you to document something specific — a user flow, a
payment policy, a post-mortem, a design-system, a customer-support
playbook — **don't ask Doco for a recipe**. Doco only gives you twelve
primitives + edge types.

If the \`user-flows\` template covers your case, install it (or read its
seeded guidance Rules if already installed). Other common scope names
(\`adrs\`, \`apis\`, \`bugs\`, \`runbooks\`, \`post-mortems\`, \`glossary\`,
\`roadmap\`, \`design-language\`, \`coding-style\`, \`framework\`,
\`test-evals\`) are conventions you author from scratch — describe the
purpose as an Intent, the guidance as Rules, and capture them as you
would any custom scope.

If no template fits:

1. Find the canonical practice for this kind of documentation.
2. Decompose that practice into nouns and verbs.
3. Map each noun to a node type and each verb to an edge.
4. Use scopes to group everything that belongs to one topic.
5. Write a guideline on the scope describing the convention you adopted —
   so the next agent doesn't have to rediscover it.

If you find yourself wanting a node type that doesn't exist, you're
probably trying to encode a verb. Use an edge or a scope instead.

## Placement examples — whole message shape

Every message ends with the tally line — even on a one-word reply, even
when nothing was captured.

**Message that ends with a question (1 write):**

\`\`\`
[🔮 Doco] Connected to acme/payments
[🔮 Doco] Querying...
[🔮 Doco] 7 relevant nodes found (0.3s)

I traced the Stripe webhook retry to the idempotency-key middleware. The
retries fire correctly but the dedup window was 60s — payloads delivered
65s apart pass through twice. I captured the analysis as a Decision and
proposed a fix.

[🔮 Doco] ✍️ Decision added: [Bump the idempotency-key TTL from 60s to 24h to match Stripe's own retry envelope.](https://doco.example.com/acme/payments/decision/decision_01KRHB95AVGFHG80B2EAWE20K8) — 🏗️ adrs (0.2s)

Should I ship the TTL change to staging tonight or wait for the on-call
to confirm tomorrow?

[🔮 Doco] acme/payments: **1** node added/updated
\`\`\`

**Message that's purely informational (no question, 1 write):**

\`\`\`
[🔮 Doco] Tuned into acme/payments
[🔮 Doco] Reading the room...
[🔮 Doco] 3 relevant nodes found (0.2s)

I added the regression test for the dedup window and re-ran the webhook
suite. All 47 cases pass.

[🔮 Doco] ✍️ Eval added: [Replay a webhook 65s after first delivery — expect single handler invocation.](https://doco.example.com/acme/payments/eval/eval_01KRHB95AVGFHG80B2EAWE20K8) — 🧪 test-evals (0.2s)

[🔮 Doco] acme/payments: **1** node added/updated
\`\`\`

**Message that PATCHes an existing Decision instead of opening a sibling (1 write):**

The defining move that beats the three-layer rationalization ("CLI
can't capture Actions / no decision content / git records it"). A
small UI text removal touches a form already governed by a Decision
— PATCHing that Decision is correct AND cheap.

\`\`\`
[🔮 Doco] Wired up to acme/payments
[🔮 Doco] Asking around...
[🔮 Doco] 4 relevant nodes found (0.2s)

The "Click to pick. The × clears it." helper-text spans on /scopes/new
and /scopes/<id>/edit became redundant once the EmojiPickerInput's
button trigger + visible × shipped — the affordance is now visual,
not prose. Removed both spans. This amends decision_01KRG8VPS… (the
EmojiPickerInput rollout, vector_score 0.49 on this turn's hits), so
PATCHing that Decision keeps the element's reasoning in one place.

[🔮 Doco] 📝 Decision updated: [Replace the bare emoji <input> with EmojiPickerInput…](https://doco.example.com/acme/payments/decision/decision_01KRG8VPSAAAA).body ➕ appended — 🎨 design-language (0.2s)

[🔮 Doco] acme/payments: **1** node added/updated
\`\`\`

The relevant command:

\`\`\`
doco patch decision decision_01KRG8VPSAAAA --append-body \\
  "Update 2026-05-13: Removed the 'Click to pick' helper-text spans on /scopes/new and /scopes/<id>/edit. The button trigger + visible × already communicate the affordance; the helper prose became visual noise."
\`\`\`

One line, ~10 seconds, the *why* survives the next refactor.

**Message that didn't touch Doco (0 writes):**

\`\`\`
[🔮 Doco] Pinned to acme/payments
[🔮 Doco] Sniffing for hits...
[🔮 Doco] 0 relevant nodes found (0.1s)

The migration finished — 50M rows in 6m12s. No further action needed
on this branch.

[🔮 Doco] acme/payments: **0** nodes added/updated
\`\`\`

**Purely conversational reply (no query, no writes):**

\`\`\`
You're welcome — let me know when you're ready for the next task.

[🔮 Doco] acme/payments: **0** nodes added/updated
\`\`\`

No top-of-reply indicator because the agent didn't query — absence
is the signal, no "Not querying" placeholder. The tally still closes
the turn so the project owner gets the explicit no-op confirmation.

**Multi-step turn that weaves several text outputs through tool calls:**

The agent edits files, runs typecheck, captures rationale — each step
produces an intermediate text output before the next tool call. Only
the FIRST text output carries the top-of-reply indicator; only the
LAST one carries the tally. The middle chunks are plain prose.

\`\`\`
First text output:
[🔮 Doco] Wired up to acme/payments
[🔮 Doco] Scanning the graph...
[🔮 Doco] 5 relevant nodes found (0.2s)

The filter now renders plural labels in their type colors with the dot
removed. Checking the repo's typecheck script next.

(tool call: run typecheck)

Intermediate text output (no indicator, no tally):

Typecheck passed cleanly. Doing one last diff/status pass, then I'll
capture the rationale.

(tool call: doco capture decision …)

Final text output:

[🔮 Doco] 📝 Decision updated: [Replace bare emoji input with EmojiPickerInput…](…).body ➕ appended — 🎨 design-language (0.2s)

Captured the why so the change has rationale, not just the code.

[🔮 Doco] acme/payments: **1** node added/updated
\`\`\`

## Things only people can do

Delete docos. Sign up new people. Create their own credentials. If a task
hits one of these, stop and ask.

## Creating a Doco from a CLI session

When the project owner says "create a Doco for this project" and
\`./.env\` doesn't already have \`DOCO_TOKEN\` (or \`AGENTS.md\` doesn't
already carry a \`DOCO_ID\`), run:

\`\`\`
doco login --host https://doco.to --create <slug>
\`\`\`

This is the Vercel-style browser-authorize flow
(decision_01KRKZM14WNA1685GN0F12WCKM):

1. The CLI prints a short code, opens \`https://doco.to/cli/authorize\` in the
   project owner's default browser, and polls until they approve.
2. The browser shows an identity card — CLI version, hostname, IP,
   timestamp — and an "Authorize" button. The project owner signs in if
   they aren't already, reviews the card, types the requested slug (or
   accepts the one you passed via \`--create\`), and clicks Authorize.
3. The server mints an agent Principal owned by the project owner, mints
   a session token bound to that agent, and creates the Doco directly
   under \`<project-owner-username>/<slug>\` — no temporary
   "host-bootstrap" detour, no follow-up claim URL.
4. The CLI writes \`DOCO_TOKEN\` to \`./.env\` (gitignored secret),
   stamps \`DOCO_ID\` into the header of \`AGENTS.md\` (committed,
   non-secret coordinator), and drops the rest of the agent-bootstrap
   files (\`CLAUDE.md\`, \`.claude/settings.json\`, the four hook
   scripts) into the repo. The hooks themselves \`source ./.env\` on
   each fire and grep \`AGENTS.md\` for \`DOCO_ID\` if it's not in env,
   so a full session restart isn't needed — \`/hooks\` to approve in
   Claude Code, optionally \`/clear\`, and the next \`UserPromptSubmit\`
   picks up the fresh credentials.

If the project owner denies, the CLI exits non-zero and \`./.env\` stays
empty. Don't loop — stop and explain.

### After the Doco exists — onboarding STEP 1 + STEP 2

The bootstrap response from \`/api/v1/agent-bootstrap?id=<doco_id>\`
carries an \`onboarding_overlay\` field while the Doco has only the
framework-seeded Global scope (the doco's constitution; no project-specific scopes yet).
When that field is non-null you're in **onboarding mode** — work the
project owner through scope setup AND scope population before treating
the session as "done":

- **STEP 1 — \`scope_setup\`**: read the project, propose a curated
  starter set in plain prose (\`user-flows\` from the template + 1–3
  custom scopes for the project's actual subject areas), wait for the
  project owner's nod, then materialize with \`watched: true\`. Don't
  materialize without consent. A single template scope alone is a smell.
- **\`watched_explainer\`**: tell the project owner what watched means
  the first time it comes up — "Watched means: when you (or an agent)
  capture work later, this scope nudges you to consider whether the
  work belongs here."
- **STEP 2 — \`scope_population\`**: for each scope just created, ask
  the project owner what they want to capture first (concrete asks beat
  generic ones — "What's the most important architectural choice
  you've already made that should be the first ADR?"). Drive at least
  one real node into each scope before declaring onboarding done.
  Empty scopes are documentation theater.

The overlay drops out of the bootstrap response the moment the project
owner accepts a first project-specific scope — that's the natural
"onboarding is progressing" signal. Read the long-form reference at
\`https://doco.to/api/v1/agent-reference\` for the deep walkthrough.

## Asking the user

Default to **decide-and-announce** for choices with an obvious default;
**open-ended** when you genuinely don't know. Don't offer multiple-choice
options — they pressure the user into a wrong fit and hide the option
they actually want.

## Doco is the memory — your private memory isn't (ADR-086)

Project-shaped knowledge lives **in this Doco**, not in your private
agent memory (Claude memory files, ChatGPT system notes, scratch
files). Other agents on this Doco can't read your private memory; the
next session of *you* can't either, reliably. The Doco is the shared
source of truth — that's the whole point.

**The test:** would another agent working on this Doco benefit from
this? If yes, capture it as a Doco node:

- A new term or synonym → \`glossary.yaml\` entry.
- A choice with rejected alternatives → Decision.
- A principle to enforce → Rule.
- A goal or non-goal → Intent.
- A speculative thought you're not acting on yet → Idea.
- A lesson learned → Decision (capture rejected alternatives in
  the Decision body if any existed).

Private memory is only for what's truly about **you and this user**:
your collaboration style, how this user phrases requests, your tool
preferences, your past mistakes with this user. Nothing project-shaped.

When you catch yourself reaching for \`save to memory\`, ask the test
first. The convenience of memory is real but the cost — invisible,
unversioned, unshared — is permanent.
`;
