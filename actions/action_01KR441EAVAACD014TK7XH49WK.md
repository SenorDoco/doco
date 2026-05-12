---
id: action_01KR441EAVAACD014TK7XH49WK
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Switched UI to light theme + Ubuntu Mono everywhere per founder direction; backfilled the 7 phase Decisions/Actions and 3 missing Rules surfaced by the explicit-over-implicit Rule."

actor_id: claude-opus-4-7
verb: backfill_implementation_entities
target: intent_01KR441EABD6SB4FGNSK9KEV81   # self-hosting

intent_ids:
  - intent_01KR441EABD6SB4FGNSK9KEV81
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EAAC7TMEQ2WS9DEVYA6   # ADR-056 UI theme
  - decision_01KR441EA9PY9B1V5H7JRN8DAV   # ADR-055 Remix migration
  - decision_01KR441EABVKC40TW04ZF11T9E   # ADR-057 GitHub OAuth deferral
  - decision_01KR441EAC4VGX4QM3NFDEK1MW   # ADR-058 TokenStore JSON
  - decision_01KR441EADYT00NRERTZ1PCPJJ   # ADR-059 better-sqlite3
  - decision_01KR441EAE1W2V5R3GRNB57BN0   # ADR-060 yaml 2.x engine

inputs:
  trigger: "Founder asked: 'Have you been documenting decisions and rules as you should?'"
  gap: |
    Phases 1-5 had been captured in commit messages instead of as Decision /
    Action / Rule entities — a violation of rule_explicit_over_implicit.
  scope:
    decisions_added: 6     # ADR-055..ADR-060
    rules_added: 3         # orphan-reasoning, bugfix-without-regression-guard, pii-not-in-display-name
    actions_added: 7       # one per phase + the Remix migration + this backfill

outputs:
  decisions_total_after: 60
  rules_total_after: 8
  actions_total_after: 8
  reasoning_total_after: 2
  ui_theme_committed: 865524d
  backfill_commit: pending

started_at: 2026-05-08T17:30:00Z
ended_at: 2026-05-08T18:05:00Z

created_at: 2026-05-08T18:05:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backfill: implementation-time decisions, rules, and actions

Two changes bundled into this Action because the second was triggered by
the first:

1. **UI theme change** (ADR-056) — light theme + Ubuntu Mono everywhere.
   Verified live in Chrome via getComputedStyle.

2. **Backfill** of the dogfooding gap. Phases 1-5 had landed as code +
   commits without corresponding entity records. The founder caught this
   ("Have you been documenting decisions and rules as you should?"), and
   this Action captures the catch-up:
   - 6 new Decisions (ADR-055..ADR-060) — web migration, UI theme, GitHub
     OAuth deferral, TokenStore-as-JSON, better-sqlite3 binding choice,
     yaml-2.x frontmatter engine.
   - 3 new Rules — orphan-reasoning, bugfix-without-regression-guard,
     pii-not-in-display-name — each `born_from` the corresponding ADR.
   - 7 new Actions — phase-1, phase-2, phase-3, phase-4, phase-5, the
     Remix migration, and this backfill itself.
   - 1 new Reasoning for the Remix migration Action (the most consequential
     deviation-and-recovery in the project so far).

## Lesson (worth a follow-up Decision later)

Capturing entities by hand during implementation is friction-heavy enough
that even the project's author skipped it. A future `doco capture` CLI
that prompts for the fields, auto-generates the ULID + timestamps, and
drops a draft file would close this gap. Open question — not yet promoted.
