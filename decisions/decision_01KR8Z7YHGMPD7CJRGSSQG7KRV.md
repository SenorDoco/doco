---
id: decision_01KR8Z7YHGMPD7CJRGSSQG7KRV
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Brand cutover: rename Evalo → Doco everywhere — packages, routes, env vars, files, schema, entity IDs, DB tables, identifiers. Hard cutover; no backwards-compat shims."

slug: doco-brand-cutover
number: "ADR-083"
follows:
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (centralized agent bootstrap)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "The brand has been Doco for months. The codebase still uses Evalo everywhere — package names @evalo/*, route segments /new-evalo, env vars EVALO_TOKEN, file names evalo.yaml, entity-id prefix evalo_, the cache dir .evalo/, schema entity definition evalo_entity, even node_type 'evalo'. The user said hard cutover, no backwards compatibility. What ships?"
chosen: |
  Everything renames. No legacy aliases, no transitional shim, no
  backwards-compat redirects. The pre-cutover Evalo brand is gone after
  this Phase.

  ### Renamed surfaces

  | layer | before | after |
  |---|---|---|
  | Package scope | `@evalo/*` (10 packages) | `@doco/*` |
  | CLI bin + script | `evalo <cmd>` / `pnpm evalo` | `doco <cmd>` / `pnpm doco` |
  | Routes | `/new-evalo`, `routes/$ownerSlug.$evaloSlug.*.tsx` | `/new-doco`, `routes/$ownerSlug.$docoSlug.*.tsx` |
  | Env vars | `EVALO_TOKEN`, `EVALO_HOST`, `EVALO_ROOT`, `EVALO_PUBLIC_HOST`, `EVALO_SCHEMA_TEMPLATE` | `DOCO_*` |
  | Schema file | `schema/evalo.schema.json` | `schema/doco.schema.json` |
  | Schema definition | `evalo_entity` | `doco_entity` |
  | Schema entity-id pattern | `^evalo_<ulid>` | `^doco_<ulid>` |
  | node_type enum value | `"evalo"` | `"doco"` |
  | Per-Doco root file | `evalo.yaml` | `doco.yaml` |
  | Cache dir | `.evalo/cache.db` | `.doco/cache.db` |
  | DB table | `evalo_root` | `doco_root` |
  | DB column | `evalo_id` | `doco_id` |
  | All identifiers | `evaloSlug`, `evaloId`, `evaloPath`, `createEvaloInHost`, `EvaloRecord`, `Evalo` interface, `migrateScopesInEvalo` | `doco*` equivalents |
  | All entity files (153+) | `doco_id: evalo_<ulid>` | `doco_id: doco_<ulid>` |
  | Markdown bodies | "Evalo" prose | "Doco" prose |

  ### Implementation: bulk text replace + file renames

  ```sh
  # 326 source/entity files; safe because "Evaluation" contains "Evalu" not "Evalo".
  find . <prune-junk> | xargs sed -i '' \\
    -e 's/EVALO_/DOCO_/g' \\
    -e 's/Evalo/Doco/g' \\
    -e 's/evalo/doco/g'

  # Then file renames (schema, route components, evalo-mark, .evalo/ cache).
  ```

  Existing ULIDs preserved — only the prefix flipped: `evalo_01KR4...` →
  `doco_01KR4...`. Every cross-reference still resolves because the
  ULID body is identical.

  ### Test data

  `/tmp/evalo-test-host` → `/tmp/doco-test-host`. `evalos/` subdir
  inside that → `docos/`. Every per-Doco `evalo.yaml` → `doco.yaml`.
  Cache dirs deleted; reindex from scratch.

  ### Why hard cutover (and why now)

  - **Backwards-compat would be the only ongoing maintenance cost.**
    No external integrations exist yet; no third party reads
    `EVALO_TOKEN` from disk. The "compatibility surface" is
    self-imposed.
  - **Bulk find/replace is one shot.** Once done, every file matches.
    A transitional period with `evalo`-aliased symbols means writing
    them twice forever (or until a follow-up Phase deletes them).
  - **The brand confusion costs more than the migration.** Agents
    onboarding to a Doco-tracked repo see "Evalo" in env var names,
    package imports, function calls — and have to learn the dual
    naming on top of the framework itself.

alternatives:
  - name: Soft alias period — keep evalo names as deprecated re-exports
    rejected_because: "User explicitly asked for no backwards compatibility. Soft aliases drag the historical name into every grep, every onboarding, every PR description."
  - name: Cut over routes + env vars but keep package names @evalo/*
    rejected_because: "Half-cutover. Every import statement still says `from '@evalo/host'`. Reading the codebase would still teach the old name. All-or-nothing."
  - name: Preserve historical ADR bodies (don't rewrite Evalo → Doco in markdown prose)
    rejected_because: "Past ADRs documented decisions made under the Evalo name. Rewriting changes their voice slightly. But hard cutover wins: a single-name codebase reads cleaner. The git history preserves the Evalo era for anyone curious."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-10T06:30:00Z

created_at: 2026-05-10T06:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-083 — Doco brand cutover (no backwards compat)

## Why

The brand flipped to Doco months ago (Phase 12, ADR-077). What
followed kept Evalo internal names everywhere — package scope,
function names, env vars, file names, schema definitions, entity-id
prefixes. The result: agents and humans onboarding had to learn
*two* names for the same thing.

The user's framing this Phase: hard cutover, no backwards compat.

## What ships

Bulk find/replace + file renames + reinstall + reindex. 326 source
files transformed; 153+ entity files updated; 10 packages rescoped;
schema renamed; DB cache regenerated.

## Verification

```
$ pnpm -r build && pnpm -r test
[all green]

$ pnpm doco validate
✓ All entities valid.

$ grep -rn "evalo\|Evalo\|EVALO" --exclude-dir=node_modules ...
[only pnpm-lock.yaml stale entries — regenerated on install]
```

## What's deferred

- **Git history rewrite.** The git log still shows commits authored
  against `@evalo/*` paths and `EVALO_*` env vars. Rewriting history
  is destructive and bigger than this Phase needs to be.
- **External docs / blog posts** referring to Evalo. None exist yet
  (the project hasn't shipped externally). When external docs land,
  they go straight to "Doco."
