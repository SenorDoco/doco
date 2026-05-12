---
id: rule_01KR441EAGVR2GFZAP9BMTSBG8
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "Intent, reasoning, and actions that affect future decisions must be expressible as entities — no implicit knowledge."

slug: explicit-over-implicit
modality: must
severity: warning
phase: declared
applies_to:
  any_of:
    - tag: scope_meta
predicate: |
  If a fact about the project's intent, reasoning, or action affects future
  decisions, it must be expressible as an entity in some Doco. Implicit
  knowledge that lives only in chat, comments, or commit messages is misaligned
  with the framework's purpose.
expected: true
on_violation: warn

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: active
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Make intent, reasoning, and actions explicit

If a fact about the project's intent, reasoning, or action affects future
decisions, it must be expressible as an entity in some Doco.

This does NOT mean every trivial action becomes an `action` entity. The bar is:
**would a future user, human or agent, need this to align their work?** If yes,
write it down. If no, you don't have to.

The distinction matters in practice:

- A throwaway shell command to check disk space → not an Action.
- A schema migration applied to production → an Action, with a Decision and Reasoning.
- A reflexive code-style fix → not an Action.
- A renaming convention adopted across the codebase → a Decision (and usually a Rule for the lint).
