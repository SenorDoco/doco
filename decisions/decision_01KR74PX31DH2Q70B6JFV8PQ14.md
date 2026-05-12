---
id: decision_01KR74PX31DH2Q70B6JFV8PQ14
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Renamed node_type tag → scope. The categorical-label entity is now `scope`. Field tags → scopes, edge_type tagged → in_scope_of, dir tags/ → scopes/, all derivatives. Supersedes ADR-009's tag listing."

slug: tag-renamed-to-scope
number: "ADR-078"
follows:
  - decision_01KR6V6W4HMM5CBJV22FD0HFSP   # ADR-075 (the connectivity lint that introduced "scope tag" terminology)
  - decision_01KR6XDDMF2XH22F71VJ2HDEA1   # ADR-077 (follows field — same shape of common-fields rename)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "ADR-075 already used the word 'scope' for what 'tag' actually is — a topical region an entity belongs to. The misalignment between the data-model name (Tag) and the conceptual name (scope) was making AGENT.md and lint messages awkward. Should we rename?"
chosen: |
  Rename across the board:

  | Surface | Before | After |
  |---|---|---|
  | node_type | `tag` | `scope` |
  | TS interface | `Tag` | `Scope` |
  | Common field | `tags?: EntityId<"tag">[]` | `scopes?: EntityId<"scope">[]` |
  | Schema $ref | `tag_id` | `scope_id` |
  | Schema entity definition | `tag_entity` | `scope_entity` |
  | Directory | `tags/` | `scopes/` |
  | Filename prefix | `tag_<ULID>` | `scope_<ULID>` |
  | Schema id pattern | `(...|tag|...)` | `(...|scope|...)` |
  | SQLite table | `CREATE TABLE tag` | `CREATE TABLE scope` |
  | Insert case | `case "tag"` | `case "scope"` |
  | Edge type | `tagged` | `in_scope_of` |
  | Field-to-edge map | `tags → "tagged"` | `scopes → "in_scope_of"` |
  | ScopeSelector predicate key | `{ tag: <name> }` | `{ scope: <name> }` |
  | Runtime fn | `hasTag` | `hasScope` |
  | Web filter color | `tag: "#84cc16"` | `scope: "#84cc16"` |
  | Web KNOWN sets | `"tag"` | `"scope"` |
  | API server type lists | `"tag"` | `"scope"` |
  | Connectivity lint message | "Idea has no tags" | "Idea has no scopes" |
  | Connectivity lint Rule check | `applies_to.tags` | `applies_to.scopes` |

  Plus the bulk rewrite of every entity file: 149 markdown/yaml files
  had `tag_<ULID>` references in their frontmatter (`tags: [tag_X]`)
  rewritten to `scopes: [scope_X]`. ULIDs preserved; only prefixes and
  field names flipped.

  Per the no-back-compat-pre-v1 principle
  ([action_01KR6JTFDRV2GQ20DKRKKWVD93](../actions/action_01KR6JTFDRV2GQ20DKRKKWVD93.md)),
  no fallbacks. The old `tags` field is gone, the old `tag_id` schema
  ref is gone, the `tagged` edge type is gone. Reindex rebuilds the
  cache fresh, so no migration tool needed.

  ## Why "scope" not "tag"

  - **Tag** suggests a label you stick on something — categorical, flat,
    optional.
  - **Scope** suggests a topical region an entity inhabits — structural,
    hierarchical-friendly, semantically meaningful.

  The `connectivity` lint already required entities to belong to ≥1
  "scope tag" for discoverability. The double-naming (Tag entity with
  scope semantics) was friction every time we wrote a lint message or
  an ADR mentioning them. One name beats two.

  ## ScopeSelector vs scope (potential confusion)

  `ScopeSelector` is the predicate type used in `Rule.applies_to` —
  selects WHICH entities a Rule applies to. The new `scope` node type
  is a categorical entity. They're different concepts that share a
  word. Acceptable for now; if confusion emerges, rename
  `ScopeSelector` → `Selector` or `Predicate` in a separate ADR.

  The `ScopeSelector` predicate already accepts `{ scope: <name> }`
  syntax (renamed from `{ tag: <name> }` in this ADR), so the term
  matches the entity it queries.

  ## ADR-009 supersession

  ADR-009 enumerated the 11 node types and named one of them `tag`.
  ADR-078 supersedes that naming (alongside ADR-074 which added
  `idea` as the 12th type). The 12 types are now: doco, principal,
  organization, intent, idea, rule, decision, action, reasoning,
  evaluation, reference, **scope**.

alternatives:
  - name: Keep `tag` as the data-model name; just write "scope" in prose
    rejected_because: "Two names for the same thing is the friction we're trying to remove. Lint messages, AGENT.md, the schema all had to keep translating."
  - name: Add `scope` as a new node type and deprecate `tag`
    rejected_because: "Two types covering the same concept is worse than one renamed. Per no-back-compat-pre-v1, deprecation periods aren't owed."
  - name: Use `topic` instead of `scope`
    rejected_because: "ScopeSelector already calls them scopes implicitly. `topic` would mean introducing a new concept name; `scope` is already in the codebase."

rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-09T19:00:00Z

created_at: 2026-05-09T19:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-078 — `tag` renamed to `scope`

## In brief

A single concept had two names: the data-model entity was `tag`, the
conceptual usage (after ADR-075's connectivity lint introduced "scope
tags") was `scope`. ADR-078 collapses to one: **scope**.

## What changed

Everywhere `tag` appeared as a name for the categorical-label entity,
it's now `scope`. Same ULIDs throughout — only prefixes and field
names flip.

149 entity files in this Doco had their frontmatter rewritten via sed:
`tag_<ulid>` → `scope_<ulid>`, `tags:` → `scopes:`. Six files in
`tags/` were moved to `scopes/` and renamed.

Code: TS types, schema definition, indexer table, insert case, edge
mapping, ScopeSelector predicate, API server type lists, web KNOWN
sets, connectivity lint, palette colors. The phase 15 follows-cycle
lint passes unchanged because it operates on edge_type "follows", not
on this rename's edge_type "in_scope_of" (was "tagged").

## Risk surface

- The schema-version stays at `0.1` — additive renames don't trigger
  ADR-050's major bump (per the no-back-compat-pre-v1 policy, breakages
  during pre-v1 are accepted). When v1 approaches, this is the kind of
  rename that justifies the version bump.
- No new lint failures: the connectivity lint's existing 8 warnings
  (Rule entities with empty `applies_to.scopes` AND empty
  `applies_to.types`) are the same warnings as before, just with the
  field renamed.

## What this Decision intentionally doesn't touch

- `Rule.applies_to.types`: the array of node-type strings that a Rule
  applies to. Stays as `types`, since "type" already means what it
  means in TypeScript / data modeling.
- `ScopeSelector` itself: still called `ScopeSelector`. See "potential
  confusion" section above.
