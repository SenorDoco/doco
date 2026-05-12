---
id: action_01KR8Z7YHJB1Y8D2MFXEEZHWN0
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 20 — Doco brand cutover (ADR-083): Evalo → Doco everywhere; hard cutover. Plus scope management UX (ADR-084): tree view, '+ New scope', '+ Add child scope' linking via ?parent=<id>."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: doco_brand_cutover_and_scope_mgmt_ux

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR8Z7YHGMPD7CJRGSSQG7KRV   # ADR-083
  - decision_01KR8Z7YHJTEWP4QQZQ43MJMBQ   # ADR-084

follows:
  - decision_01KR8Z7YHGMPD7CJRGSSQG7KRV
  - decision_01KR8Z7YHJTEWP4QQZQ43MJMBQ
  - action_01KR8Y6VSWZE3EC5K8KNW2WV4C     # Phase 19

inputs:
  user_direction: |
    "Also, from the UX, make it easy to manage scopes.
    What is /new-evalo redirect? No. Remove everything regarding evalo,
    even redirects. All old code should be removed as we don't need
    backwards compatibility. Remember?"

    Two coupled asks:
    1. Hard cutover: drop ALL Evalo references — packages, routes,
       env vars, file names, schema, entity IDs, DB tables. No
       backwards-compat shims.
    2. Make scope management easy from the UX.

outputs:
  source_files_changed_count: 326
  entity_files_updated: "153+ (every doco_id reference, plus body text)"
  packages_renamed: "10 (@evalo/* → @doco/*)"
  files_renamed:
    - "schema/evalo.schema.json → schema/doco.schema.json"
    - "packages/cli/templates/evalo.schema.json → templates/doco.schema.json"
    - "evalo.yaml → doco.yaml (meta-Doco root)"
    - "packages/web/app/components/evalo-mark.tsx → doco-mark.tsx"
    - "packages/web/app/routes/new-evalo.tsx → new-doco.tsx"
    - "packages/web/app/routes/$ownerSlug.$evaloSlug.*.tsx → $ownerSlug.$docoSlug.*.tsx (6 files)"
  test_data_migrated:
    - "/tmp/evalo-test-host → /tmp/doco-test-host"
    - "evalos/<owner>/<slug> → docos/<owner>/<slug>"
    - "Each per-Doco evalo.yaml → doco.yaml"
    - ".evalo/ cache dirs deleted (regenerable)"

  scope_ux_added:
    - "Scope list (/e/scope in host mode): tree rendering with depth indent, member/sub counts, purpose preview"
    - "Always-visible '+ New scope' button on the scope list"
    - "Empty-state copy + link to /scopes/new?onboarding=1 when zero scopes"
    - "'+ child' button on each tree row → /scopes/new?parent=<id>"
    - "'+ Add child scope' link on scope detail card header (host mode + single-Doco mode)"
    - "/scopes/new accepts ?parent=<id>: banner + auto-prefixes custom-input paths under that parent"

  test_status: |
    pnpm -r build → all 10 packages green
    pnpm -r test → all 10 packages green (87 tests)
    pnpm doco validate → ✓ All entities valid (counts: decision 84, action 46, scope 6)
    pnpm doco lint → 8 pre-existing connectivity warnings (unchanged)
    Reindex: 157 entities in 11 ms (cache: .doco/cache.db)

constraints_observed:
  - "Hard cutover: no legacy aliases, no transitional re-exports, no /new-evalo redirect to /new-doco."
  - "ULIDs preserved through the rename: evalo_<ulid> → doco_<ulid> (only prefix flipped)."
  - "Bulk find/replace safe: 'Evaluation' contains 'Evalu' not 'Evalo'."
  - "pnpm-lock.yaml regenerated cleanly (10 packages rescoped to @doco/*)."
  - "Scope UX changes scoped to host-mode list/detail (single-Doco list still flat — meta-Doco scopes are all flat anyway)."

decisions_consulted:
  - decision_01KR8Z7YHGMPD7CJRGSSQG7KRV   # ADR-083 (this Phase's brand cutover)
  - decision_01KR8Z7YHJTEWP4QQZQ43MJMBQ   # ADR-084 (this Phase's scope mgmt UX)
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (centralized agent bootstrap — affected by env var renames)
  - decision_01KR8Y6VSS2TBQFQ2AQCXB81TK   # ADR-081 (edge-hierarchical scopes)

started_at: 2026-05-10T06:00:00Z
ended_at: 2026-05-10T06:35:00Z

created_at: 2026-05-10T06:35:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 20 — Doco brand cutover + scope management UX

## What

**Brand cutover (ADR-083).** Bulk find/replace across 326 source +
entity files plus targeted file renames. After this Phase the codebase
contains zero `evalo` references (excluding archived git history). All
10 packages rescoped to `@doco/*`. CLI is `pnpm doco` / `doco <cmd>`.
Env vars: `DOCO_TOKEN`, `DOCO_HOST`, `DOCO_ROOT`. Cache dir: `.doco/`.
Schema entity-id pattern: `^doco_<ulid>$`. node_type enum value
`"doco"`.

**Scope management UX (ADR-084).** Three coordinated UI moves on top
of the existing `/scopes/new` flow: tree rendering on the scope list,
always-visible `+ New scope` button, and `+ Add child scope` links on
every scope detail that prefill the parent via `?parent=<id>` on
`/scopes/new`.

## Verification

```
$ grep -rn "evalo\\|Evalo\\|EVALO" --exclude-dir=node_modules \\
    --exclude-dir=dist --exclude-dir=.git --exclude-dir=build \\
    --exclude-dir=.doco --exclude-dir=.react-router \\
    --exclude pnpm-lock.yaml
[no matches]

$ pnpm doco validate
✓ All entities valid.

$ pnpm doco lint | grep -c '^!'
8

$ pnpm -r test
[all 10 packages green]
```

## What's deferred

- **Single-Doco mode `/e/scope` tree.** Same logic, separate route
  file. Apply when the meta-Doco grows hierarchical scopes.
- **Inline edit for scope purpose/guidelines.** Edit the YAML for now.
- **Scope reparent / delete UI.** Premature.
- **Git history rewrite.** Commits still authored against `@evalo/*`
  paths. Destructive; deferred indefinitely.
