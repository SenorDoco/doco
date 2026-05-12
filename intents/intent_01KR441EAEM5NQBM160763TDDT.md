---
id: intent_01KR441EAEM5NQBM160763TDDT
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Ship a working v0: CLI, source layer, index, identity, API, web app, importers, rule discovery."

slug: implementation-v0
title: Ship a working v0 implementation
priority: p0
parent_intent_id: null

non_goals:
  - Ship every feature in PLANNING.md before v0 is callable. Importers and the web UI can land after the CLI + API.
  - Replace prose docs (PLANNING.md, SCHEMA.md, DECISIONS.md) with the migrated entities. Both coexist until v0 stabilizes.

acceptance:
  - "`doco init` creates a valid Doco (greenfield)."
  - "`doco init --existing` runs the brownfield branch (with backfill choice)."
  - "`doco show <id>`, `doco query <sql>`, `doco find-rules` work against a populated Doco."
  - "Source-of-truth: file readers/writers for entity YAML+Markdown with schema validation (`schema/doco.schema.json`)."
  - "Index: SQLite + FTS5 cache (`.doco/cache.db`), `edges` adjacency table, `scope_match` denormalization, incremental updater on commit / file change."
  - "Identity: GitHub OAuth (humans), invitation/session tokens (agents), `DOCO_TOKEN` env-var consumption."
  - "API: REST CRUD + query + discovery + events stream; OpenAPI generation."
  - "Web app: recent-changes feed, list-by-kind, search, entity detail, graph view as secondary."
  - "Importers: at least Slack, GitHub PRs, agent transcripts."
  - "System Rules + lints: `rule_system_only_humans_delete`, agent-without-human-ancestor, orphan-Reasoning, bug-fix-without-regression-guard."

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
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Ship a working v0 implementation

Everything in DECISIONS.md §12 (the "what an implementer needs to build" list)
maps to acceptance items above. As implementation proceeds, each piece becomes
an Action (or chain of Actions) authorized by the Decisions in `decisions/`.

This intent intentionally has no `parent_intent_id` — it's a peer of
intent_01KR441EA92V53H22ZN087YMRM (alignment-framework), not a child. The
framework is *what* we're building; this intent is the *commitment to deliver*
a working implementation.
