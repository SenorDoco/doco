---
id: decision_01KR441EBWS09RRX4BTQQPT9MJ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Two onboarding paths: greenfield (`doco init`) and brownfield (`doco init --existing`). Brownfield asks an explicit fork: backfill or document forward-only."

slug: greenfield-and-brownfield-onboarding
number: "ADR-041"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "How do new users start using Doco when they have, or don't have, prior project history?"
chosen: |
  Two paths:
    - **`doco init`** (greenfield) — empty Doco, scaffolded directories,
      empty-state UI prompts for the first Intent.
    - **`doco init --existing`** (brownfield) — explicit fork: (a)
      document only decisions going forward, or (b) backfill past decisions
      from prior context (Slack, email, code, docs, ...).

  Surfacing the brownfield fork early avoids regret — half of real adoption
  is brownfield.
alternatives:
  - name: One init path
    rejected_because: "Brownfield is half of real adoption; treating it as a footnote misses the use case."
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

# ADR-041 — Two onboarding paths: greenfield and brownfield

Reference: PLANNING.md §1.
