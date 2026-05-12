---
id: action_01KREJDGKX7QZ613XRHPB4TNCQ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Teach the memory-vs-Doco boundary to every Doco-using agent: add ADR-086, glossary entries for Doco + meta-doco, and a new 'Doco is the memory' section in the canonical agent bootstrap (packages/api/src/instructions.ts)."

actor_id: claude-opus-4-7
verb: teach_agents_to_capture_knowledge_in_doco

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decisions_consulted:
  - decision_01KREJDGKVBHGARG3ATJ80YBZ4   # ADR-086 (this Action's source decision)
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (centralized agent bootstrap — the surface we edit)

inputs:
  trigger: |
    User caught the agent saving a vocabulary distinction
    (Doco vs meta-doco) into private Claude memory instead of
    into the Doco's glossary. User framing:

    > Why did you document this on your MD as opposed to the meta-doco?

    Followed by:

    > Not only do we need to learn that, but we need to teach agents
    > using Doco to keep that in mind. What do we have to do?
    > Let's fix it.

outputs:
  shipped:
    - "ADR-086 — knowledge-lives-in-doco-not-agent-memory (decisions/decision_01KREJDGKVBHGARG3ATJ80YBZ4.md)"
    - "Glossary entries for `Doco` and `meta-doco` at top of glossary.yaml"
    - "New 'Doco is the memory — your private memory isn't (ADR-086)' section in packages/api/src/instructions.ts; instruction-file docstring updated to cite ADR-086"
    - "Removed redundant feedback_doco_vocabulary.md from private agent memory; MEMORY.md index pruned"

  expected_effect: |
    Every agent that fetches `GET $DOCO_HOST/api/v1/agent-bootstrap` on
    its next session will read the new section and learn the test:
    "would another agent working on this Doco benefit from this?"
    Project-shaped artifacts (vocabulary, decisions, rules, intents,
    ideas, reasoning, actions) flow into Doco; only collaboration-
    shaped notes (style, tool prefs, mistakes with this user) stay in
    private memory.

created_at: 2026-05-12T10:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
started_at: 2026-05-12T10:00:00Z
ended_at: 2026-05-12T10:00:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Action — teach the memory-vs-Doco boundary

## Why this earns an Action

The instructions tell agents to write Actions for meaningful work.
This Action's work is precisely the thing the decision teaches:
capture it in the Doco so future agents see what we shipped, when,
and why — instead of relying on the next session of any one agent
to remember.

## What landed

1. **[ADR-086](../decisions/decision_01KREJDGKVBHGARG3ATJ80YBZ4.md)** —
   the canonical Decision. Project-shaped knowledge in Doco;
   collaboration-shaped in private memory; never both.
2. **glossary.yaml** — `Doco` and `meta-doco` as proper terms with
   description + synonyms, available to Rule-discovery semantic search.
3. **packages/api/src/instructions.ts** — new section "Doco is the
   memory — your private memory isn't (ADR-086)" at the tail of the
   canonical instructions. Brief, prescriptive, with the one-sentence
   test. Cited in the file's docstring so the link back to the ADR is
   discoverable from the code.
4. **Removed agent-memory duplicate** — the `feedback_doco_vocabulary.md`
   I had just written to my private memory was deleted; the canonical
   record is the glossary + ADR-086.

## What this Action does NOT do

- No Rule added. Private memory is external to the Doco; a Doco lint
  can't introspect it. ADR-086 records that escalation path is
  available if observed drift demands it.
- No update to the in-repo AGENT.md stub. That file is intentionally
  thin per ADR-080; the substance lives in `instructions.ts`.
