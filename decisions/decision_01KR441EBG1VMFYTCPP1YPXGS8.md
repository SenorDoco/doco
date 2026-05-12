---
id: decision_01KR441EBG1VMFYTCPP1YPXGS8
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Cross-Doco imports are pinned (git ref), namespaced (`as: policy`), additive (local + imported Rules co-apply), and explicitly overridable via `superseded_by`."

slug: cross-doco-imports-pinned-namespaced-additive
number: "ADR-029"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
question: "How does an Doco pull in Rules from another Doco (compliance baselines, vendor SDKs, organization-wide policy)?"
chosen: |
  `imports[].doco` references another Doco at a pinned `ref` (git tag/branch/commit),
  under a local namespace (`as: policy`). Imported entities get namespaced IDs
  (`policy:rule_01H...`).

  - **Matching**: additive — local + imported Rules all apply.
  - **Override**: explicit — local Rule with `superseded_by: policy:rule_...`.
  - **Versioning**: pinned `ref`; bumping it produces a diff.
  - **Transitive imports**: one level by default — no surprise rule cascades.
alternatives:
  - name: Floating refs (track main of imported Doco)
    rejected_because: "Surprise rule changes flow in without review. Imports must be auditable."
  - name: Imported Rules silently override local
    rejected_because: "Nothing should silently disappear. Override is explicit."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-029 — Cross-Doco imports: pinned, namespaced, additive

Same model as code package managers — versioned, explicit, overrideable,
auditable.

Reference: SCHEMA.md §9.4.
