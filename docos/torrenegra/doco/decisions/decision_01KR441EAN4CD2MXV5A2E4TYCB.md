---
id: decision_01KR441EAN4CD2MXV5A2E4TYCB
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "An Doco IS a git repository. One file per entity in node-named directories."

slug: storage-is-git-repository
number: "ADR-002"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM   # alignment-framework
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "Where does an Doco's data live?"
chosen: |
  An Doco is a git repository. Each entity is a single file in a node-named
  directory (intents/, rules/, decisions/, ...). The file tree IS the
  source-of-truth.
alternatives:
  - name: Database-backed primary store
    rejected_because: "Loses git-native version control (priority 5). Branching and diffs become custom plumbing instead of free."
  - name: Content-addressed object store
    rejected_because: "Heavier; less developer-mental-model friendly; agents are less fluent in object-store APIs than in filesystem layouts."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D   # tag_adr
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# ADR-002 — Storage = git repository (one file per entity)

Version control, branching, diffs, and merge are free. Per-clone local indices
live in `.doco/` outside source-of-truth (D-023).

Reference: SCHEMA.md §2.
