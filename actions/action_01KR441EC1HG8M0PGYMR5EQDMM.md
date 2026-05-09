---
id: action_01KR441EC1HG8M0PGYMR5EQDMM
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Bootstrap the Evalo project as its own first Evalo: directory layout, schema, principals, tags, references, intents, rules, decisions, action, reasoning."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ   # claude-opus-4-7 (agent)
verb: bootstrap_evalo
target: evalo_01KR441EA0ZDMF0N5DY38GSVS3

intent_ids:
  - intent_01KR441EABD6SB4FGNSK9KEV81   # self-hosting
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0

decision_ids:
  - decision_01KR441EAN4CD2MXV5A2E4TYCB   # ADR-002 Storage = git repository
  - decision_01KR441EAPAGA5XME562JACT5Q   # ADR-003 YAML frontmatter + Markdown body
  - decision_01KR441EAWNQ4ZAPG0XGA9RJZX   # ADR-009 Final node type list

inputs:
  source_documents:
    - PLANNING.md
    - SCHEMA.md
    - DECISIONS.md
  fixed_timestamp: 2026-05-08T15:42:00Z   # bootstrap moment for ULIDs

outputs:
  entities_created:
    evalo: 1
    principal: 2
    tag: 6
    reference: 3
    intent: 6
    rule: 5
    decision: 45
    action: 1
    reasoning: 1
  total: 70
  config_files:
    - evalo.yaml
    - .gitignore
    - glossary.yaml
    - schema/evalo.schema.json

started_at: 2026-05-08T15:42:00Z
ended_at: 2026-05-08T16:00:00Z

created_at: 2026-05-08T15:42:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Bootstrap the Evalo project

The agent (Claude Opus 4.7, invited 2026-05-08T15:42:00Z by torrenegra) read
the existing prose design at `PLANNING.md`, `SCHEMA.md`, and `DECISIONS.md`,
and populated this directory with the schema-conforming entity files that
*are* the Evalo project's first Evalo.

## What was created

| Kind | Count | Notes |
|---|---|---|
| evalo | 1 | `evalo.yaml` at root |
| principal | 2 | torrenegra (human, owner), claude-opus-4-7 (agent, contributor) |
| tag | 6 | `tag_adr`, `tag_bugfix`, `tag_regression_guard`, `tag_adr_consequence`, `tag_userflow`, `scope_meta` |
| reference | 3 | one per source design doc |
| intent | 6 | alignment-framework, runtime-checking, self-hosting, dual-user-model, agent-comprehension-first, implementation-v0 |
| rule | 5 | priority-order, explicit-over-implicit, only-humans-delete-evalo, agent-ancestry-terminates-at-human, no-secrets-in-evalo |
| decision | 45 | DECISIONS.md ADR-001..ADR-045 |
| action | 1 | this Action |
| reasoning | 1 | reasoning_01KR441EC28S1517BVHDM774ZJ — the inferential bridge for this Action |

## What was deferred

- **Predicate language for Rules** (DECISIONS.md §13 #1) — left as prose.
- **Rename `principal/evaluation/reference`** (§13 #3) — kept as-is.
- **`is_agent: bool` vs `type: human | agent`** (§13 #2) — kept as `type`.
- **`evalo` CLI implementation** — implementation-v0 intent is open; the
  bootstrap was done by direct file writes by the invited agent.
- **`.evalo/cache.db` index** — also part of implementation-v0; not built yet.
- **Initial git commit** — left untouched per the user's project guidance
  (auto-mode does not commit without an explicit request).

## Reasoning

See [reasoning/reasoning_01KR441EC28S1517BVHDM774ZJ.md](../reasoning/reasoning_01KR441EC28S1517BVHDM774ZJ.md).
