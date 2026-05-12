---
id: action_01KR6QZCHJFPX79DGVAF44K0F8
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 11 — added `idea` as the 12th node type. Schema, branded types, Entity union, indexer table, API counts, web KNOWN sets, site-nav tab, AGENT.md, first idea entity, ADR-074. Eats its own dog food: the first idea proposed adding ideas."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: add_idea_node_type
target: doco_01KR441EA0ZDMF0N5DY38GSVS3

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6QZCH0RSDB22YC5H6M4BKZ   # ADR-074 (this Action operationalizes it)
  - decision_01KR441EAWNQ4ZAPG0XGA9RJZX   # ADR-009 — superseded by ADR-074

inputs:
  founder_choice: |
    From a brainstorm of A/B/C, the user picked C: add `idea` as the 12th
    node type with a lightweight schema (summary + body + proposer +
    optional promoted_to / rejection_reason).

outputs:
  source_files_changed:
    - schema/doco.schema.json                              # id pattern, namespaced_id, idea_entity, oneOf
    - packages/shared/src/branded.ts                        # NODE_TYPES gains "idea"
    - packages/shared/src/entities.ts                       # Idea interface; Entity union
    - packages/core/src/paths.ts                            # ENTITY_DIRS["idea"] → ideas/, md format
    - packages/index/src/migrate.ts                         # CREATE TABLE idea
    - packages/index/src/insert.ts                          # case "idea" branch + deleteEntity table list
    - packages/runtime/src/check.ts                         # type list for findById
    - packages/lints/src/orphan-reasoning.ts                # anyTableHasId list
    - packages/api/src/server.ts                            # countByType + isKnownType lists
    - packages/web/app/routes/e.$type._index.tsx            # KNOWN set
    - packages/web/app/routes/e.$type.$id.tsx               # KNOWN set
    - packages/web/app/routes/$ownerSlug.$docoSlug.e.$type._index.tsx  # KNOWN set
    - packages/web/app/routes/$ownerSlug.$docoSlug.e.$type.$id.tsx     # KNOWN set
    - packages/web/app/components/site-header.tsx           # added Ideas nav tab in both nav variants
    - AGENT.md                                              # data-model table updated 11→12 types
    - ideas/idea_01KR6QZCHKRJH1YH2V6EXQ7S9H.md              # FIRST idea — "Document ideas" — promoted to ADR-074
    - decisions/decision_01KR6QZCH0RSDB22YC5H6M4BKZ.md      # ADR-074
    - packages/index/src/__tests__/build.test.ts            # bumped counts (idea: 1)
    - packages/core/src/__tests__/loader.test.ts            # decision lower-bound bumped
  schema_change_kind:
    - "Additive — existing entities don't change shape"
    - "schema_version stays 0.1 (per ADR-050; we're pre-v1)"
    - "No migration tool needed"

started_at: 2026-05-09T15:50:00Z
ended_at: 2026-05-09T16:05:00Z

created_at: 2026-05-09T16:05:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 11 — Idea as the 12th node type

## What ships

A new node type `idea` flows through the whole stack:

- **Schema**: `idea_<ULID>` ids, an `idea_entity` definition, a slot in
  the `oneOf` union of all entities.
- **Code**: `Idea` TS interface, member of the `Entity` union, an entry
  in `NODE_TYPES`, a directory binding (`ideas/`, markdown format),
  an indexer table with the four idea-specific columns, an insert
  case, type-list updates everywhere a list-of-known-types appears.
- **UI**: `/e/idea` index + `/e/idea/:id` detail routes Just Work
  thanks to the dynamic `$type` routing. A new `Ideas` tab in the
  per-Doco nav.
- **First idea**: `ideas/idea_01KR6QZCHKRJH1YH2V6EXQ7S9H.md`, the
  meta-idea proposing this very change. Promoted to ADR-074
  (`promoted_to: <decision-id>`), `lifecycle: succeeded`. Models the
  arc future ideas follow.

## The dog-food moment

The first idea entity in this Doco is the proposal to add ideas. It
was promoted to a Decision (ADR-074) and an Action (this one) within
the same turn. Hopefully later ideas have longer shelf lives.

## What about ADR-009

ADR-009 (final node type list, 11 types) is now superseded by ADR-074.
The supersession is captured in `decision_ids` of both this Action
and ADR-074's frontmatter. ADR-009's prose stays as historical
record — it explains the criteria the type list earned its place by,
which still apply.

## Pre-v1 schema discipline

The change is additive. No existing entities reshape. `schema_version`
stays at `0.1`. Per ADR-050, additive changes ship freely while we're
pre-v1.0. When we approach 1.0 the bar rises — schema changes need
migration tooling and version bumps. Today we just write the type and
move on.
