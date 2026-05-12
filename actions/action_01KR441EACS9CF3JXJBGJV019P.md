---
id: action_01KR441EACS9CF3JXJBGJV019P
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: rename the project (and the unit-of-scoping entity type) from 'Doco' to 'Aligno'. Major-version schema bump."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: rename_project_doco_to_aligno

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
  - intent_01KR441EABD6SB4FGNSK9KEV81   # self-hosting (this is itself an Doco, so the rename applies to this repo too)

decision_ids:
  - decision_01KR441EA4F19H61WSEDAYAHVH   # ADR-050 schema versioning policy (major bump required)
  - decision_01KR441EAQ1J516HMAMZ66NKRJ   # ADR-004 IDs are <node_type>_<ULID> — entity ID prefixes change
  - decision_01KR441EAWNQ4ZAPG0XGA9RJZX   # ADR-009 final node type list — `doco` becomes `aligno`

inputs:
  founder_direction: "Rename doco into aligno"

outputs:
  expected:
    brand:
      - "Project name: Doco → Aligno (every README, doc, prose mention)"
      - "Wordmark / logotype SVG title text + asset filenames"
      - "Domain target doco.to → aligno.<tld> (ADR-053 phase-6 deploy)"
    schema_breaking_change:
      - "doco_<ulid> entity ID prefix → aligno_<ulid>"
      - "node_type 'doco' → 'aligno'"
      - "Schema id pattern: (doco|...) → (aligno|...)"
      - "doco.yaml → aligno.yaml at the root of every Doco (Aligno)"
      - "doco_id common field → aligno_id"
      - "schema_version major bump (per ADR-050) to 1.0 — breaking change"
    code:
      - "Package names @doco/* → @aligno/* (shared, core, cli, index, runtime, lints, discovery, host, api, web)"
      - "CLI binary: doco → aligno"
      - "Env vars: DOCO_ROOT → ALIGNO_ROOT, DOCO_TOKEN → ALIGNO_TOKEN, DOCO_EMBEDDING_API_KEY → ALIGNO_EMBEDDING_API_KEY, DOCO_SCHEMA_TEMPLATE → ALIGNO_SCHEMA_TEMPLATE"
      - ".doco/ cache dir → .aligno/"
      - ".doco/cache.db, tokens.json paths"
      - "Cookie name doco_session → aligno_session"
      - "Reserved-slug list updated (e/host/api stay; review whether 'doco' itself should be reserved)"
    data:
      - "Migration tool: rewrites all doco_<ulid> IDs to aligno_<ulid> (or keeps ULIDs and only flips prefixes — preferred since ULIDs are stable identities)"
      - "Migrates all 100+ entity files in this repo (the meta-Doco) to use aligno_id and aligno_<ulid> references"
      - "Migrates schema/doco.schema.json → schema/aligno.schema.json with renamed definitions"
    repository:
      - "Repo rename /Users/torrenegra/Doco → /Users/torrenegra/Aligno (or stays per user preference)"
      - "Git history preserved (git supports directory rename via mv + commit)"

created_at: 2026-05-09T03:15:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: abandoned
status: abandoned
abandoned_reason: "Brand pivoted to Doco; Phase 12 (action_01KR6SND6D2WBY1619QT6GJFSG) shipped the visible rename. The deeper code/schema rename was queued briefly then dropped at the founder's direction — not on the roadmap. Technical surface stays 'doco' indefinitely; only the user-facing brand changed. Re-confirmed abandoned 2026-05-12 alongside Action #9 (collapse to local-solo) backlog grooming."
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — rename Doco to Aligno

Major rebrand and schema-breaking rename. Per [ADR-050](../decisions/decision_01KR441EA4F19H61WSEDAYAHVH.md)
this is a major version bump (schema_version → "1.0"); a migration tool
must ship alongside, idempotent, with `--dry-run` and `--rollback`.

## Suggested implementation order (when picked up)

1. **Decide** (a precursor proposed Decision):
   - Should the entity-type prefix really change (`doco_<ulid>` → `aligno_<ulid>`),
     or only the project's user-facing branding while keeping the schema's
     internal name? The cleaner answer is full rename; the cheaper answer is
     branding-only. Surface this tradeoff explicitly.
   - Final domain (aligno.to? aligno.dev? aligno.app?).
2. **Schema migration tool** — `aligno migrate from-doco <root>` walks an
   Doco (or Host) tree and rewrites IDs, fields, paths, and the schema
   file. Idempotent.
3. **Package rename** — pnpm rename @doco/* → @aligno/*; bin: aligno.
4. **Brand assets** — favicon, logotype, wordmark titles updated.
5. **Re-bootstrap** the framework's own meta-Doco (this repo) using the
   new names — exercises the migration path.
6. **Reserved slug list** — keep `e` reserved; remove `doco` if added;
   ensure `aligno` itself isn't user-takeable.
7. **Docs** — PLANNING.md / SCHEMA.md / DECISIONS.md / READMEs replace
   every "Doco" mention with "Aligno". Decisions ADR-001..ADR-067
   continue to reference the OLD framework name for historical accuracy
   in their bodies; only the structured fields migrate.

## Risk / blast radius

Touches every package, every entity file (~110 in this repo today), every
README, the schema, the CLI binary, env vars, cookies, and downstream
consumers (none yet, but anything seeded under `/tmp/test-host` would
need to migrate too). High risk if rushed; modest with a tested migration
tool.
