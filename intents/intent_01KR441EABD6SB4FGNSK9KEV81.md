---
id: intent_01KR441EABD6SB4FGNSK9KEV81
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Doco describes itself in its own schema — the project IS an Doco."

slug: self-hosting
title: Doco is its own first Doco
priority: p1
parent_intent_id: null

non_goals:
  - Force every project that uses Doco to be self-hosted. Most won't be.
  - Bootstrap a separate "meta-Doco" — this directory IS the meta-Doco.

acceptance:
  - "The Doco project's intents, rules, decisions, actions, and references are expressed as entities in this repository under `intents/`, `rules/`, etc."
  - "All 45 decisions in DECISIONS.md are migrated to `decisions/decision_*.md`."
  - "The schema in SCHEMA.md validates the entities (via `schema/doco.schema.json`)."
  - "When the project later grows implementation code, the meta-Doco coexists with it (likely in `.doco/` — D-002 + D-023)."

stakeholders:
  - torrenegra

applies_to:
  any_of:
    - tag: scope_meta

created_at: 2026-05-08T15:42:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: active
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Doco describes itself in its own schema

The project's own design choices are captured as entities in this Doco. This
forces the schema to be expressive enough for a real project from day 0, and
provides a worked example for new users.

If something can't be expressed in the schema, the schema is wrong. The
bootstrap is the harshest test — and the most reusable one, since every
new Doco follows the same shape.

When the project later grows implementation code (CLI, library, API server,
web app), this decision will be revisited — likely the implementation lives
at `src/`, `apps/`, etc., and the meta-Doco moves to `.doco/` to coexist.
That migration is itself a Decision-worthy moment.
