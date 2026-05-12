---
id: decision_01KR441EBQQZXZ7J304KJF72P0
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Username convention: humans = GitHub login; agents = `{owner_username}/{ISO_timestamp}` where the timestamp is the moment the agent's Principal was created."

slug: username-convention
number: "ADR-036"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "How are usernames structured for humans and agents?"
chosen: |
  - **Human**: GitHub login (e.g., `torrenegra`).
  - **Agent**: `{owner_username}/{creation_timestamp_ISO_8601}` (e.g., `torrenegra/2026-05-08T15:42:00Z`).

  Lineage is visible at a glance, and multiple agents under one owner get
  distinct usernames automatically.
alternatives:
  - name: Random IDs for agent usernames
    rejected_because: "Loses lineage visibility; humans must consult Principal records to know who an agent reports to."
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

# ADR-036 — Username convention

Reference: PLANNING.md §2.3, SCHEMA.md §4.1.
