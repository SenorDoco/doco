---
id: decision_01KR441EAPAGA5XME562JACT5Q
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Entities are stored as YAML frontmatter (structured) plus Markdown body (narrative); both audiences in one file."

slug: yaml-frontmatter-plus-markdown-body
number: "ADR-003"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2   # agent-comprehension-first
question: "What file format do entities use?"
chosen: |
  Structured fields in YAML frontmatter; narrative in Markdown body. The
  unit of change is one file per entity. Agents parse YAML cleanly; humans
  read Markdown narrative.
alternatives:
  - name: Pure JSON
    rejected_because: "Cleaner for agents, worse for humans (priority 3). Forces narrative into escaped strings."
  - name: Pure Markdown (no frontmatter)
    rejected_because: "Worse for agents — no structured field surface, every value parsed from prose."
  - name: SQLite as primary store
    rejected_because: "Bad for agent updates (priority 2): rows in a binary db require tooling vs. a text-file Edit. Also weak for version control (priority 5)."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-003 — File format = YAML frontmatter + Markdown body

For YAML-only entities (Principal, Tag, Reference, Evaluation, Doco root),
the file is `.yaml`. For entities with a narrative body (Intent, Rule,
Decision, Action, Reasoning), the file is `.md` with frontmatter.

Reference: SCHEMA.md §2.
