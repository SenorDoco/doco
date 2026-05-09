---
id: action_01KR441EACS9CF3JXJBGJV019P
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: rename the project (and the unit-of-scoping entity type) from 'Evalo' to 'Aligno'. Major-version schema bump."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: rename_project_evalo_to_aligno

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
  - intent_01KR441EABD6SB4FGNSK9KEV81   # self-hosting (this is itself an Evalo, so the rename applies to this repo too)

decision_ids:
  - decision_01KR441EA4F19H61WSEDAYAHVH   # ADR-050 schema versioning policy (major bump required)
  - decision_01KR441EAQ1J516HMAMZ66NKRJ   # ADR-004 IDs are <node_type>_<ULID> — entity ID prefixes change
  - decision_01KR441EAWNQ4ZAPG0XGA9RJZX   # ADR-009 final node type list — `evalo` becomes `aligno`

inputs:
  founder_direction: "Rename evalo into aligno"

outputs:
  expected:
    brand:
      - "Project name: Evalo → Aligno (every README, doc, prose mention)"
      - "Wordmark / logotype SVG title text + asset filenames"
      - "Domain target evalo.to → aligno.<tld> (ADR-053 phase-6 deploy)"
    schema_breaking_change:
      - "evalo_<ulid> entity ID prefix → aligno_<ulid>"
      - "node_type 'evalo' → 'aligno'"
      - "Schema id pattern: (evalo|...) → (aligno|...)"
      - "evalo.yaml → aligno.yaml at the root of every Evalo (Aligno)"
      - "evalo_id common field → aligno_id"
      - "schema_version major bump (per ADR-050) to 1.0 — breaking change"
    code:
      - "Package names @evalo/* → @aligno/* (shared, core, cli, index, runtime, lints, discovery, host, api, web)"
      - "CLI binary: evalo → aligno"
      - "Env vars: EVALO_ROOT → ALIGNO_ROOT, EVALO_TOKEN → ALIGNO_TOKEN, EVALO_EMBEDDING_API_KEY → ALIGNO_EMBEDDING_API_KEY, EVALO_SCHEMA_TEMPLATE → ALIGNO_SCHEMA_TEMPLATE"
      - ".evalo/ cache dir → .aligno/"
      - ".evalo/cache.db, tokens.json paths"
      - "Cookie name evalo_session → aligno_session"
      - "Reserved-slug list updated (e/host/api stay; review whether 'evalo' itself should be reserved)"
    data:
      - "Migration tool: rewrites all evalo_<ulid> IDs to aligno_<ulid> (or keeps ULIDs and only flips prefixes — preferred since ULIDs are stable identities)"
      - "Migrates all 100+ entity files in this repo (the meta-Evalo) to use aligno_id and aligno_<ulid> references"
      - "Migrates schema/evalo.schema.json → schema/aligno.schema.json with renamed definitions"
    repository:
      - "Repo rename /Users/torrenegra/Evalo → /Users/torrenegra/Aligno (or stays per user preference)"
      - "Git history preserved (git supports directory rename via mv + commit)"

created_at: 2026-05-09T03:15:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: proposed
status: planned
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — rename Evalo to Aligno

Major rebrand and schema-breaking rename. Per [ADR-050](../decisions/decision_01KR441EA4F19H61WSEDAYAHVH.md)
this is a major version bump (schema_version → "1.0"); a migration tool
must ship alongside, idempotent, with `--dry-run` and `--rollback`.

## Suggested implementation order (when picked up)

1. **Decide** (a precursor proposed Decision):
   - Should the entity-type prefix really change (`evalo_<ulid>` → `aligno_<ulid>`),
     or only the project's user-facing branding while keeping the schema's
     internal name? The cleaner answer is full rename; the cheaper answer is
     branding-only. Surface this tradeoff explicitly.
   - Final domain (aligno.to? aligno.dev? aligno.app?).
2. **Schema migration tool** — `aligno migrate from-evalo <root>` walks an
   Evalo (or Host) tree and rewrites IDs, fields, paths, and the schema
   file. Idempotent.
3. **Package rename** — pnpm rename @evalo/* → @aligno/*; bin: aligno.
4. **Brand assets** — favicon, logotype, wordmark titles updated.
5. **Re-bootstrap** the framework's own meta-Evalo (this repo) using the
   new names — exercises the migration path.
6. **Reserved slug list** — keep `e` reserved; remove `evalo` if added;
   ensure `aligno` itself isn't user-takeable.
7. **Docs** — PLANNING.md / SCHEMA.md / DECISIONS.md / READMEs replace
   every "Evalo" mention with "Aligno". Decisions ADR-001..ADR-067
   continue to reference the OLD framework name for historical accuracy
   in their bodies; only the structured fields migrate.

## Risk / blast radius

Touches every package, every entity file (~110 in this repo today), every
README, the schema, the CLI binary, env vars, cookies, and downstream
consumers (none yet, but anything seeded under `/tmp/test-host` would
need to migrate too). High risk if rushed; modest with a tested migration
tool.
