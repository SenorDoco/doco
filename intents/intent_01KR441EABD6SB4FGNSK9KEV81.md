---
id: intent_01KR441EABD6SB4FGNSK9KEV81
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Evalo describes itself in its own schema — the project IS an Evalo."

slug: self-hosting
title: Evalo is its own first Evalo
priority: p1
parent_intent_id: null

non_goals:
  - Force every project that uses Evalo to be self-hosted. Most won't be.
  - Bootstrap a separate "meta-Evalo" — this directory IS the meta-Evalo.

acceptance:
  - "The Evalo project's intents, rules, decisions, actions, and references are expressed as entities in this repository under `intents/`, `rules/`, etc."
  - "All 45 decisions in DECISIONS.md are migrated to `decisions/decision_*.md`."
  - "The schema in SCHEMA.md validates the entities (via `schema/evalo.schema.json`)."
  - "When the project later grows implementation code, the meta-Evalo coexists with it (likely in `.evalo/` — D-002 + D-023)."

stakeholders:
  - principal_01KR441EA199MZCP7RDMADFZW9

applies_to:
  any_of:
    - tag: scope_meta

created_at: 2026-05-08T15:42:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: active
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Evalo describes itself in its own schema

The project's own design choices are captured as entities in this Evalo. This
forces the schema to be expressive enough for a real project from day 0, and
provides a worked example for new users.

If something can't be expressed in the schema, the schema is wrong. The
bootstrap is the harshest test — and the most reusable one, since every
new Evalo follows the same shape.

When the project later grows implementation code (CLI, library, API server,
web app), this decision will be revisited — likely the implementation lives
at `src/`, `apps/`, etc., and the meta-Evalo moves to `.evalo/` to coexist.
That migration is itself a Decision-worthy moment.
