---
id: decision_01KR441EB71JXXK3NS1NTK0NWR
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Canonical URL form for entities: `doco://{doco_slug}/{node_type}/{slug_or_id}`. Both slug and ID resolve."

slug: url-form
number: "ADR-020"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2
question: "What is the canonical URL form for referencing an entity?"
chosen: |
  `doco://{doco_slug}/{node_type}/{slug_or_id}`. Both slug and ID resolve
  to the same entity. Agents prefer linking by ID (forever-stable across
  rename); humans prefer linking by slug (readable).
alternatives:
  - name: ID-only URLs
    rejected_because: "Humans need readable URLs. Cross-reference robustness comes from slug aliasing (D-019), not from disallowing slugs."
  - name: Slug-only URLs
    rejected_because: "Loses cross-Doco stability when slugs evolve (even with aliasing, an agent reading a long-lived link wants the canonical ID form)."
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

# ADR-020 — URL form
