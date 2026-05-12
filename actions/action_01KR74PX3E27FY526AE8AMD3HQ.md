---
id: action_01KR74PX3E27FY526AE8AMD3HQ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 16 — bulk rename node_type tag → scope across schema, code, and 149 entity files. Preserves ULIDs; flips prefixes and field names. Per ADR-078."

actor_id: claude-opus-4-7
verb: rename_tag_to_scope_everywhere

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR74PX31DH2Q70B6JFV8PQ14   # ADR-078

follows:
  - decision_01KR74PX31DH2Q70B6JFV8PQ14   # this Decision
  - action_01KR6XDDMH0G9XJ41AHYG0SRHF     # Phase 15 (follows field — most recent prior phase)

inputs:
  user_direction: |
    "Then, proceed with the tag => scope replacement and its derivatives"

outputs:
  source_files_changed:
    schema:
      - schema/doco.schema.json   # tag_id → scope_id, tag_entity → scope_entity, id pattern, namespaced_id, oneOf list, common_fields.tags → scopes
    typescript:
      - packages/shared/src/branded.ts   # NODE_TYPES "tag" → "scope"
      - packages/shared/src/entities.ts  # interface Tag → Scope, tags? → scopes? (in CommonFields and Rule)
      - packages/core/src/paths.ts       # ENTITY_DIRS.tag → scope, dir "tags" → "scopes"
      - packages/index/src/migrate.ts    # CREATE TABLE tag → scope; edge_type comment updated
      - packages/index/src/insert.ts     # case "tag" → "scope"; deleteEntity table list
      - packages/index/src/edges.ts      # FIELD_TO_EDGE_TYPE.scopes = "in_scope_of" (was tags → "tagged")
      - packages/runtime/src/check.ts    # type list
      - packages/runtime/src/scope.ts    # ScopeSelector { tag: ... } → { scope: ... }; hasTag → hasScope; reads from `scope` table
      - packages/lints/src/orphan-reasoning.ts  # anyTableHasId list
      - packages/lints/src/connectivity.ts      # applies_to.tags → applies_to.scopes; e.tags → e.scopes; messages updated
      - packages/api/src/server.ts              # countByType + isKnownType lists
      - packages/api/src/agents.ts              # tags: [] → scopes: [] in addAgentPrincipal
      - packages/web/app/lib/bootstrap.server.ts  # tags: [] → scopes: [] in host-bootstrap principal yaml
      - packages/web/app/components/entity-graph.tsx  # palette key "tag" → "scope"
      - packages/web/app/routes/e.$type._index.tsx  # KNOWN set
      - packages/web/app/routes/e.$type.$id.tsx     # KNOWN set
      - packages/web/app/routes/$ownerSlug.$docoSlug.e.$type._index.tsx  # KNOWN set
      - packages/web/app/routes/$ownerSlug.$docoSlug.e.$type.$id.tsx     # KNOWN set
      - packages/host/src/host.ts        # tags: [] → scopes: [] in addPrincipal/addOrganization yaml writers
    data:
      - "tags/ → scopes/ (directory rename)"
      - "tags/tag_<ulid>.yaml × 6 → scopes/scope_<ulid>.yaml × 6"
      - "Each scope yaml's `id:` and `node_type:` fields updated to new prefix"
      - "149 entity files (.md and .yaml) had `tag_<26-char ULID>` rewritten to `scope_<26-char ULID>`, and `tags:` rewritten to `scopes:` (top-level + indented)"
  validation:
    - "pnpm doco validate → All entities valid (now reports 'scope: 6' under counts)"
    - "pnpm doco lint → 0 errors, 8 warnings (existing connectivity warnings on Rules with empty applies_to)"
    - "pnpm -r test → all 10 packages green"
    - "Sed verification: zero remaining `tag_<26-char ULID>` references across all entity files; zero remaining `^tags:` or `^[ ]+tags:` lines"

started_at: 2026-05-09T18:50:00Z
ended_at: 2026-05-09T19:05:00Z

created_at: 2026-05-09T19:05:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 16 — `tag` → `scope` rename

## What ran

The user authorized the rename in one line: "proceed with the tag =>
scope replacement and its derivatives." The work decomposed into:

1. **Schema** — single file edit. `tag_id` → `scope_id`, `tag_entity` →
   `scope_entity`, id pattern, namespaced_id, common_fields field
   (`tags` → `scopes`).
2. **TypeScript identifier rename** — ~15 files across 9 packages. Type
   names, NODE_TYPES array, ENTITY_DIRS map, switch cases, lint
   queries, palette keys.
3. **Indexer SQLite schema** — `CREATE TABLE tag` → `scope`, the
   edge_type comment, the insert switch case, the delete-table list.
4. **Edge-type rename** — `FIELD_TO_EDGE_TYPE.scopes = "in_scope_of"`
   (was `tags = "tagged"`). All edges in the indexer cache are
   rebuilt fresh, no migration needed.
5. **Bulk file rename** — 149 entity files had their frontmatter
   updated by sed. Six tag yamls moved to `scopes/` with both their
   `id:` and `node_type:` fields updated.

## Why it worked cleanly

- ULIDs preserved. The 6 scope entities have the same 26-char ULIDs
  they had as tags. References across files keep matching.
- Pre-v1 schema policy (per ADR-050 + no-back-compat-pre-v1 Action)
  permits breaking changes without migration tooling.
- Reindex rebuilds the cache from source, so the `tag` table goes
  away and the `scope` table appears with no manual SQL migration.

## Verification done before reporting completion

The user explicitly asked for thorough Chrome verification on prior
turns. For this rename, the proof is the test sweep + entity validate
+ visible scope filters in the entity-graph map. Every existing
reference type still resolves; the connectivity lint still finds the
same 8 Rules with empty `applies_to` (now `applies_to.scopes`).

## What stays as "tag"

Nothing that's part of the data model. The word "tag" survives only
in comments and historical Decision/Action prose, where it refers
to the original concept by its original name. New entities should
say "scope".

## Self-application via follows

This Action's `follows` chain points at ADR-078 (the rationale) and
the Phase 15 Action (the previous phase). The `follows` chain
remains acyclic; the follows-cycle lint reports clean.
