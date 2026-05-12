---
id: action_01KR6W4643E036C8MJ3Z7GEFFM
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog (re-added): rename ALL Doco references to Doco — TS identifiers, package names, env vars, .doco/ → .doco/, doco.yaml → doco.yaml, every entity id doco_<ulid> → doco_<ulid>, cookie name. Schema major bump per ADR-050."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: rename_all_doco_references_to_doco

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EA4F19H61WSEDAYAHVH   # ADR-050 — schema versioning policy
  - decision_01KR441EAQ1J516HMAMZ66NKRJ   # ADR-004 — IDs are <node_type>_<ULID>

inputs:
  founder_direction: |
    "Add to backlog: Make sure that all references to Doco including,
    including any variable or global environment, whatever, are
    replaced with Doco."
  context: |
    Phase 12 (action_01KR6SND6D2WBY1619QT6GJFSG) shipped the *visible*
    rename. The *technical* rename was queued, then removed from the
    backlog (action_01KR6THB6D1PQJ441B9BFCW4Q4 — "remove the rename
    from backlog"), then re-added now. Founder wants the full sweep
    after all.

outputs:
  expected:
    schema_changes:
      - "schema/doco.schema.json → schema/doco.schema.json"
      - "id pattern: (intent|idea|...|doco|...) → (intent|idea|...|doco|...)"
      - "namespaced_id pattern: same"
      - "doco_entity definition → doco_entity"
      - "node_type: 'doco' const → 'doco'"
      - "doco_id field name on every entity → doco_id"
      - "schema_version major bump 0.1 → 1.0 per ADR-050 (rename is breaking)"
    code_changes:
      packages:
        - "@doco/shared → @doco/shared"
        - "@doco/core → @doco/core"
        - "@doco/cli → @doco/cli"
        - "@doco/index → @doco/index"
        - "@doco/runtime → @doco/runtime"
        - "@doco/lints → @doco/lints"
        - "@doco/discovery → @doco/discovery"
        - "@doco/host → @doco/host"
        - "@doco/api → @doco/api"
        - "@doco/web → @doco/web"
      identifiers:
        - "DocoMark → DocoMark (component + filename doco-mark.tsx → doco-mark.tsx)"
        - "listAllDocos → listAllDocos"
        - "HostDoco → HostDoco"
        - "loadDoco, openDocoDb, getDocoSlug, docoPath, docoRoot, docoId, docoSlug, etc."
        - "SingleDocoRecent → SingleDocoRecent"
        - "createDocoInHost → createDocoInHost"
        - "TokenStore.forDoco → TokenStore.forDoco"
        - "Type Doco → Doco; type EntityId<'doco'> → EntityId<'doco'>"
      cli_binary: "doco → doco (npm bin)"
      env_vars:
        - "DOCO_TOKEN → DOCO_TOKEN"
        - "DOCO_HOST → DOCO_HOST"
        - "DOCO_ROOT → DOCO_ROOT"
        - "DOCO_PUBLIC_HOST → DOCO_PUBLIC_HOST"
        - "DOCO_SCHEMA_TEMPLATE → DOCO_SCHEMA_TEMPLATE"
        - "(OPENAI_API_KEY stays — already aligned with Speco; not a Doco-prefixed var)"
      cache_dir: ".doco/cache.db, .doco/tokens.json → .doco/cache.db, .doco/tokens.json"
      root_file: "doco.yaml → doco.yaml at the root of every tracked project"
      cookie: "doco_session → doco_session"
      reserved_slug_list: "remove 'doco', add 'doco'"
    data_changes:
      - "Every entity file's `id` field: doco_<ulid> → doco_<ulid> for the Doco-type entities"
      - "Every entity's `doco_id` reference field → `doco_id`"
      - "Migration tool must rewrite ~125+ entity files in this repo plus any user-created ones"
    repository:
      - "/Users/torrenegra/Doco → /Users/torrenegra/Doco (optional but consistent)"
      - "Git history preserved across the rename"
    web_routes:
      - "/new-doco → /new-doco"
      - "/e/doco → /e/doco"
      - "Reserved slugs updated"

  migration_tool:
    spec:
      - "doco migrate from-doco <root>"
      - "Idempotent: re-running on a migrated tree is a no-op"
      - "Dry-run mode: print plan, change nothing"
      - "Rollback mode: re-applies the inverse mapping (within a single migration step)"
      - "Walks: schema files, every entity file, .doco/ dir, env-using scripts, package.json files, lockfiles"
      - "Outputs a manifest of changed files for review"
    edge_cases:
      - "Decisions/Actions/Reasoning whose body text says 'Doco' as a brand reference — leave the prose alone (historical record); rewrite only the structured frontmatter and code blocks."
      - "URL-pinned external references (e.g. doco.dev/schemas/v0.1) — leave as historical reference; new URL pattern uses doco.dev or whichever final domain."

implementation_order:
  - "1. Decide on the canonical domain (doco.dev? doco.app? doco.to?)."
  - "2. Build doco migrate from-doco with --dry-run + tests against this repo."
  - "3. Update schema major version to 1.0 in the migration step (per ADR-050)."
  - "4. Run migration on this repo (the meta-Doco). Verify all 4 lints clean + all tests green."
  - "5. Reserve doco slug; update reserved-slug list."
  - "6. Rename packages (@doco/* → @doco/*). Update internal imports."
  - "7. Rename CLI binary."
  - "8. Update env vars (DOCO_TOKEN/HOST/ROOT/PUBLIC_HOST/SCHEMA_TEMPLATE → DOCO_*). Skip OPENAI_API_KEY (kept)."
  - "9. Re-bootstrap: run `doco host init` on a fresh dir to verify the post-rename state matches a brand-new install."
  - "10. Optional: rename the repo on disk."

created_at: 2026-05-09T17:48:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: proposed
status: planned
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog (re-added) — Rename ALL Doco references to Doco

This Action was first queued, then removed from the backlog
(`action_01KR6THB6D1PQJ441B9BFCW4Q4` deleted it), then re-added now
at the founder's direction:

> "Make sure that all references to Doco including, including any
> variable or global environment, whatever, are replaced with Doco."

The visible rename (Phase 12) handled page titles, headings, prose,
wordmark. This Action covers everything else: TS identifiers, package
names, env vars, the schema's id pattern, every `doco_<ulid>` entity
id, the `.doco/` cache directory, the `doco.yaml` root file, the
`doco_session` cookie, and the schema major-version bump per
ADR-050.

## Why this needs care

It's a breaking schema change (ADR-050 territory). The migration tool
needs `--dry-run` and rollback. ~125 entity files in this repo each
carry an `doco_id` field plus references to other `doco_<ulid>` ids;
all of them rewrite atomically.

The `OPENAI_API_KEY` env var is the one explicit exception — that's
already aligned with Speco's convention (per
`action_01KR6W4640XHFBQQV0C1A4TYFR`) and stays unprefixed.

## When to pick up

The previous "remove from backlog" Action argued the cost wasn't
worth it. Re-adding means the cost-benefit shifted. Likely triggers
for actually executing:

- The technical/visual dissonance becomes annoying when reading the
  code.
- A new external user is onboarding and seeing `DOCO_TOKEN` in docs
  while the brand is "Doco" looks unprofessional.
- A v1.0 cut is approaching and we want to ship 1.0 with the names
  matching.

## Anti-patterns to avoid

- Don't try a partial rename (e.g. only rename packages, leave entity
  ids alone). Mixed state is worse than fully-old or fully-new.
- Don't keep old prefixes as an alias. Per
  `action_01KR6JTFDRV2GQ20DKRKKWVD93` (no back-compat pre-v1), there's
  no installed base owed compatibility.
- Don't rewrite historical Decisions/Actions/Reasoning prose. Those
  documents reference "Doco" because that's what the project was
  named at the time. Their structured fields migrate; their prose
  stays as historical record.

## Note on history

The previous trajectory:
1. Aligno rename Action (originally planned target name)
   → marked `abandoned` when brand pivoted to Doco
2. Doco brand-rename completed (Phase 12, visible only)
3. Doco code/schema rename queued
4. Doco code/schema rename deleted (founder said remove from backlog)
5. Doco code/schema rename re-added (this Action — founder reversed)

The history is preserved in those Actions' lifecycles. Re-adding
isn't undoing #4; it's a separate decision in the present.
