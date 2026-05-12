---
id: decision_01KR441EB0180W94FYGMNHFVMM
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Decision and Rule are kept distinct. Decision = recorded choice with rejected alternatives. Rule = continuously-evaluated correctness statement."

slug: decision-and-rule-are-distinct
number: "ADR-013"
intent_ids:
  - intent_01KR441EA92V53H22ZN087YMRM
question: "Are Decision and Rule actually the same thing?"
chosen: |
  Keep separate. Decision = a recorded choice (one-shot, with rejected
  alternatives, retrospective). Rule = a constraint that holds (continuous,
  evaluated repeatedly, predicate-bearing). Different lifecycle, different
  shape (Decision has `alternatives[]`; Rule has `predicate`).

  Test that decides: "Can this produce an Evaluation?" → Rule. "Does this
  carry rejected alternatives?" → Decision. The bug-fix pattern (Decision
  spawns regression-guard Rule via `born_from`) shows how they pair.
alternatives:
  - name: Unify Decision and Rule
    rejected_because: "Different shape and different evaluation cadence. Forcing them together loses the rejected-alternatives field on Decision and the predicate field on Rule, both load-bearing."
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

# ADR-013 — Decision and Rule are distinct (don't unify)

Reference: SCHEMA.md §4.4 (Rule), §4.5 (Decision).
