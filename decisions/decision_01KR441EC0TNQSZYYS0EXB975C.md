---
id: decision_01KR441EC0TNQSZYYS0EXB975C
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Web home is a chronological feed of Actions/Decisions/Evaluations (filterable). Graph is a per-entity drill-down, not primary navigation."

slug: recent-changes-feed-is-home
number: "ADR-045"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "What is the primary web navigation — graph view, list views, or a feed?"
chosen: |
  Default home view is a chronological feed of Actions / Decisions /
  Evaluations (filterable by kind / actor / time / topic). Graph is a
  per-entity drill-down ("show neighborhood"), not primary navigation.
  Mirrors GitHub's home dashboard, which users already understand.
alternatives:
  - name: Graph view as primary navigation
    rejected_because: "Graph navigation acknowledged as 'doesn't work well' as a primary entry point — node-edge spaghetti is not how humans want to start their day. The graph IS the data structure, but it's a *secondary* view."
  - name: Per-kind list views as primary
    rejected_because: "Doesn't surface alerting items (failed Evaluations, blocked Actions) up-front. Recent-changes does."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:31:00Z

created_at: 2026-05-08T15:31:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-045 — Recent-changes feed = home; graph = secondary

The graph is data, not interface. List views + recent-changes feed +
filtered queries cover most user intent. Graph is for explicit traversal,
never the home.

Reference: PLANNING.md §5.3, §5.4.
