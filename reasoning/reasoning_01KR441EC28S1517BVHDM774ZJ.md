---
id: reasoning_01KR441EC28S1517BVHDM774ZJ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: reasoning
schema_version: "0.1"
summary: "Premises (self-hosting intent + foundational decisions) → conclusion (bootstrap action). Reasoning for action_01KR441EC1HG8M0PGYMR5EQDMM."

author_id: claude-opus-4-7   # claude-opus-4-7

premises:
  - node_type: intent
    ref: intent_01KR441EABD6SB4FGNSK9KEV81
    as: "Doco describes itself in its own schema (self-hosting)."
  - node_type: intent
    ref: intent_01KR441EAEM5NQBM160763TDDT
    as: "Ship a working v0 — and the tightest validation of the schema is migrating an existing 45-decision design into it."
  - node_type: decision
    ref: decision_01KR441EAN4CD2MXV5A2E4TYCB
    as: "An Doco is a git repository with one file per entity in node-named directories (ADR-002)."
  - node_type: decision
    ref: decision_01KR441EAPAGA5XME562JACT5Q
    as: "Entities are YAML frontmatter + Markdown body (ADR-003) — agent-parseable structure plus human-narrative."
  - node_type: decision
    ref: decision_01KR441EAWNQ4ZAPG0XGA9RJZX
    as: "Ten node types capture the alignment graph (ADR-009): principal, doco, intent, rule, decision, action, reasoning, evaluation, reference, tag."
  - node_type: decision
    ref: decision_01KR441EAQ1J516HMAMZ66NKRJ
    as: "IDs are `{node_type}_{ULID}` (ADR-004); ULIDs are time-sortable and need no central coordinator."

inference: |
  Given the self-hosting intent and the foundational storage / format / node-type
  decisions, the bootstrap action is mechanical: produce one file per entity in
  the appropriate directory, with frontmatter conforming to schema/doco.schema.json
  and a body adding human-narrative context. ULIDs are generated with a fixed
  bootstrap timestamp (2026-05-08T15:42:00Z) so they sort in a coherent order.

  The bootstrap action serves both intents (self-hosting, implementation-v0)
  and is authorized by ADR-002, ADR-003, and ADR-009. Subsequent implementation
  work (CLI, index, API, web app) will be authorized by their own decisions
  and produce their own actions.

conclusion_ref: action_01KR441EC1HG8M0PGYMR5EQDMM
confidence: 0.9
uncertainty:
  - "Whether the migrated decision bodies should be terser (one-paragraph) or fuller (the full DECISIONS.md prose)."
  - "Whether the bootstrap timestamp (2026-05-08T15:42:00Z) is the right canonical for ULIDs vs. using the actual original design time of each decision."
  - "Whether file naming `decision_<ulid>.md` (ID-only) is the right tradeoff vs. `decision_<ulid>__<slug>.md` (ID + human-readable suffix). I went with ID-only per SCHEMA.md §2's literal convention; if humans find the directory unnavigable, this should be revisited."
  - "Whether `Principal` for the Doco entity needs `doco_id` self-referentially. I omitted it on the Doco entity since the root is structurally special; the JSON Schema accommodates this."

created_at: 2026-05-08T15:42:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: active
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Reasoning for the bootstrap action

This Reasoning entity is the inferential bridge from the foundational
Intents and Decisions to the bootstrap Action. It exists as a separate
entity (per ADR-012) so that multi-author critique remains possible — a
human reviewer can attach their own Reasoning to the same Action with a
different premise set, different confidence, or different uncertainty
list, and both reasonings are preserved.

## Open questions surfaced by the bootstrap

The `uncertainty[]` field above lists implementation-time judgment calls that
are *not* the same as the 12 open questions in DECISIONS.md §13. Those are
about the design; these are about the migration. They should be reviewed by
the founder and either resolved (creating Decision entities) or left as
known unknowns until usage tells us which direction to take.
