---
id: decision_01KREJDGKVBHGARG3ATJ80YBZ4
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Project-shaped knowledge lives in the Doco (glossary, decisions, rules, intents, ideas, reasoning, actions). Private agent memory is only for collaboration-shaped notes about *this* agent and *this* user. Never both."

slug: knowledge-lives-in-doco-not-agent-memory
number: "ADR-086"
follows:
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (centralized agent bootstrap — instructions live on host)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "When an agent learns something while working in a Doco — a new term, a decided convention, a rejected alternative, a lesson — where does it go: into the agent's private memory (Claude's memory files, system instructions, scratch notes), into the Doco, or both?"
chosen: |
  Project-shaped knowledge lives **in the Doco**, as the appropriate node
  type. Private agent memory holds **only** what's about the agent and its
  collaboration with a specific user.

  ### The split

  | Belongs in the Doco | Belongs in private agent memory |
  |---|---|
  | Vocabulary (glossary entry) | How this user phrases requests |
  | Choices with rejected alternatives (Decision) | The agent's tool preferences |
  | Principles to enforce (Rule) | Past mistakes this agent has made with this user |
  | Goals + non-goals (Intent) | How terse vs. verbose this user wants responses |
  | Speculative thoughts not yet acted on (Idea) | Where this user keeps their `.env` |
  | Why a choice was reached (Reasoning) | The agent's own collaboration style |
  | Work done in the project (Action) |  |

  ### The test (single sentence)

  *Would another agent working on this Doco benefit from knowing this?*
  Yes → it goes in a Doco node. No → it stays in private memory.

  ### Why this matters

  - **Shared, not siloed.** Doco nodes are queryable by every agent on
    this Doco. Private memory is invisible to every agent except the one
    that wrote it. Project knowledge stuck in one agent's memory is
    knowledge the next agent has to re-derive.
  - **Version-controlled.** Doco nodes live in git. Private memory is
    not versioned with the project; it drifts and rots.
  - **Auditable.** Doco nodes have authorship, timestamps, lineage. Private
    memory has none of that.
  - **Doco's whole point.** The framework exists so that intent, decisions,
    rules, and actions become explicit, queryable, and verifiable. Hiding
    them in agent memory defeats the framework.

  ### Why agents drift toward private memory

  Memory systems (Claude's, ChatGPT's, etc.) are convenient: a single tool
  call, no schema to obey, no commit needed. When an agent is mid-task and
  picks up a fact, the path-of-least-resistance is `save to memory`. The
  agent has to deliberately pivot to "this is project-shaped — write a Doco
  node instead." The canonical instructions (ADR-080) must teach this
  pivot explicitly; absent it, agents default to memory.

  ### What changes

  1. **Canonical instructions** (`packages/api/src/instructions.ts`) gains
     a brief "What goes in Doco vs your private memory" section. Every
     agent that fetches the bootstrap learns the rule on next session.
  2. **Glossary** entries for "Doco" and "meta-doco" already landed in
     this same change wave.
  3. **No Rule** — runtime enforcement isn't feasible (private memory is
     external to the Doco). This is a *behavioral* convention taught
     via the instructions, not a runtime-checked Rule.

alternatives:
  - name: Leave the choice to the agent
    rejected_because: "Demonstrated this session that agents default to private memory when not told otherwise. Without explicit guidance, project knowledge silos in one agent's memory and is invisible to the next. The user's framing was exactly this: 'we need to teach agents using Doco to keep that in mind.'"
  - name: All knowledge in Doco; no private memory at all
    rejected_because: "Pollutes the Doco with collaboration-style notes that have no value to other agents (how user prefers terse responses, tool quirks, etc.). Mixes audiences. Worse: humans reading the Doco would see agent meta-chatter mixed with project artifacts."
  - name: All knowledge in private memory; Doco only for code-adjacent artifacts
    rejected_because: "Inverts Doco's purpose. Doco exists precisely to externalize agent reasoning into a shared, queryable artifact. If we route knowledge to memory by default, we're back to opaque agents."
  - name: Both — write everything to both Doco and memory
    rejected_because: "Two sources of truth always drift. Once they diverge, future agents have to guess which is canonical. Pick one (Doco), point the other (memory) at it for the narrow slice it covers."
  - name: Make this a Rule with lint enforcement
    rejected_because: "Private memory is external to the Doco — the lint can't see it. The convention is enforceable only by the agents themselves reading the instructions. Lints catch the inverse (collaboration-shaped notes that leaked *into* Doco) but the predicate is hand-wavy enough not to earn the Rule keep yet."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-12T10:00:00Z

created_at: 2026-05-12T10:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D   # scope_adr
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# ADR-086 — Knowledge lives in the Doco, not in private agent memory

## How this was caught

This Decision exists because the agent (Claude Opus 4.7 acting under
torrenegra) wrote a vocabulary distinction — "Doco" the product vs
"meta-doco" the self-hosted instance — into its private memory at
`/Users/torrenegra/.claude/projects/-Users-torrenegra-Evalo/memory/`
instead of into [glossary.yaml](../glossary.yaml). The user surfaced the
mistake directly:

> Why did you document this on your MD as opposed to the meta-doco?

The fix (this ADR + the instructions.ts update) ensures every future
agent reads the rule on its next bootstrap, not after a user catches
them mid-mistake.

## Implementation

- Glossary entries for `Doco` and `meta-doco` live in
  [glossary.yaml](../glossary.yaml).
- The "What goes in Doco vs your private memory" section in
  `packages/api/src/instructions.ts` (the canonical agent bootstrap) is
  the operational teaching surface.
- This ADR is the canonical reference for *why* the rule exists; cite
  it from future instructions edits, rules, or onboarding flows.

## Not enforced by a Rule

Private agent memory lives outside the Doco's git tree. A Doco lint
can't introspect Claude's `/memory/` directory (or ChatGPT's system
instructions, or any other agent's scratch space). The rule is a
behavioral convention, enforced by the instructions every agent reads
at session start. If we later observe agents drifting back to private
memory despite the rule, escalate to a runtime nudge (e.g., agent
self-reports via the bootstrap response, or the agent's own memory
system warns when it sees Doco-shaped content).
