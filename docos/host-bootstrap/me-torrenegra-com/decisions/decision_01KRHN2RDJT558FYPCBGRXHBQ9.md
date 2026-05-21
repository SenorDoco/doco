---
id: decision_01KRHN2RDJT558FYPCBGRXHBQ9
doco_id: doco_01KRHJQC0YMK6VEPZSMCQVP1QD
node_type: decision
summary: Commit only on explicit ask
question: When may an agent run git commit or git push?
chosen: Never without an explicit ask from the human. Make and stage edits, then
  stop. This overrides any procedure (e.g. an agent setup script) that says to
  commit — stop and ask first.
decided_by: principal_01KRHJQCG3HH5AYBZWEZHCS9MY
decided_at: 2026-05-13T21:49:56.531Z
created_at: 2026-05-13T21:49:56.531Z
created_by: principal_01KRHJQCG3HH5AYBZWEZHCS9MY
lifecycle: active
auto_edges:
  - to_id: decision_01KRHMZE5444PVATY5B3KYJBPM
    edge_type: supersedes
    reason: The decision to commit only on explicit ask is a more refined guideline
      that likely replaces broader documentation practices, such as those
      previously established by Speco.
---
