---
id: decision_01KR441EA8QFSX5Q6CHNVCKMJ0
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Batch resolution of DECISIONS.md §13 open questions #2, #3, #5, #6, #7, #8, #11, #12. Each kept as designed unless noted."

slug: open-questions-batch-resolution-2026-05-08
number: "ADR-054"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "How are the remaining DECISIONS.md §13 open questions resolved before phase 1 starts?"
chosen: |
  Settled in one pass on 2026-05-08:

  - **#2 (`is_agent: bool` vs `type: human \| agent`)**: KEEP `type`. No rename.
  - **#3 (rename principal/evaluation/reference to user/check/source)**: KEEP current names. They're precise auth/check/source language and well-trained.
  - **#5 (per-entity visibility)**: NO. Evalo-level visibility only for v0.
  - **#6 (token revocation cascade scoped override)**: NO. Strict cascade always for v0.
  - **#7 (GitHub-only sign-in permanence)**: V0 SIMPLIFICATION. Revisit when adoption demands OIDC/SAML.
  - **#8 (Token as first-class entity)**: NO. Confirms D-039 — tokens stay external.
  - **#11 (Plan / Question entities)**: NO. Both stay deferred.
  - **#12 (PII in agent ancestry chain)**: ADD a Rule in phase 3 lints — `display_name MUST NOT match email regex`.
alternatives:
  - name: Defer some / all to mid-implementation
    rejected_because: "Founder is going off-line; resolving now lets implementation proceed without ambiguity. Re-opening any specific question later is cheap."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T16:30:00Z

created_at: 2026-05-08T16:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-054 — Batch resolution of open questions #2, #3, #5, #6, #7, #8, #11, #12

A single Decision rather than 8 separate ones because none of these required
schema or architecture changes — they confirm the existing design as the v0
direction. Each can be re-opened later as its own Decision if usage shows
otherwise. The PII rule (#12) will be born from this Decision when it lands
in phase 3.

## Status of all 13 open questions after this Decision

| # | Status | Resolved by |
|---|---|---|
| 1 | Resolved | ADR-048 (JSON DSL for v0) |
| 2 | Resolved | This Decision (keep `type`) |
| 3 | Resolved | This Decision (keep names) |
| 4 | Resolved | ADR-050 (additive within major) |
| 5 | Resolved | This Decision (no per-entity visibility) |
| 6 | Resolved | This Decision (strict cascade only) |
| 7 | Resolved | This Decision (v0 simplification, revisit later) |
| 8 | Resolved | This Decision (no Token entity) |
| 9 | (no #9 — DECISIONS.md numbering goes 1-13 with no gap; verify) | — |
| 10 | Resolved | ADR-051 (drop conclusion_node_type) |
| 11 | Resolved | This Decision (no Plan/Question) |
| 12 | Resolved | This Decision (PII rule in phase 3) |
| 13 | Resolved | ADR-049 (Tier B scale) |

13 → 0 open questions as of this Decision. New ones will be added to
DECISIONS.md §13 (and eventually migrated to per-entity proposed Decisions
when that convention is adopted).
