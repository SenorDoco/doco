---
id: action_01KR6THB6D1PQJ441B9BFCW4Q4
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Removed the deep code/schema rename from the backlog. Visible brand stays 'Doco'; technical surface stays 'doco' indefinitely. Updated the Phase 12 Action's framing and superseded earlier rename Actions to abandoned."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9   # torrenegra (founder)
verb: remove_doco_rename_from_backlog

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EA4F19H61WSEDAYAHVH   # ADR-050 — schema versioning policy (no longer triggered by a major bump)

inputs:
  user_direction: |
    "Remove from the backlog the item to rename doco."

outputs:
  source_files_changed:
    - actions/action_01KR6SND6V9XVSZT5B6F01SB7S.md         # DELETED — was the planned code/schema rename
    - actions/action_01KR441EACS9CF3JXJBGJV019P.md         # Aligno rename: lifecycle was 'superseded'; now 'abandoned' (no successor — broken superseded_by ref removed)
    - actions/action_01KR6G9454VZM160S7HHZWBVBY.md         # Aligno brand assets: abandoned_reason rewritten to drop refs to the deleted Action
    - actions/action_01KR6SND6D2WBY1619QT6GJFSG.md         # Phase 12 (completed visible rename): scope_split flattened; "what stays doco" reframed from "deferred" to "permanent"; refs to deleted Action removed
  what_this_means:
    - "User-visible brand: 'Doco' everywhere (per Phase 12 — completed)."
    - "Technical surface: stays 'doco' permanently. TS identifiers, schema fields, package names, env vars, .doco/, doco.yaml, doco_<ulid> ids, doco_session cookie — none of it migrates."
    - "The split is acceptable as long as the two surfaces stay clearly separated: brand for users, doco for the implementation. Future readers of the code will need to know the project's user-facing name differs from its TS-identifier name."
  test_count_delta:
    - "Actions: net 0 (deleted 1, added 1)"

started_at: 2026-05-09T16:55:00Z
ended_at: 2026-05-09T16:58:00Z

created_at: 2026-05-09T16:58:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Removed Doco→Doco code/schema rename from the backlog

## What changed

The previously-planned Phase B (technical rename — package names, env
vars, schema id pattern, .doco/ → .doco/, every entity ID's prefix)
is no longer queued. Deleted the Action that captured it.

References cleaned up:
- The Phase 12 Action (visible rename, completed) had a `scope_split`
  describing this Phase B as a follow-up. That section now reads as a
  single scope ("visible brand only") with an explicit note that the
  technical surface stays "doco" permanently.
- The Aligno rename Action's `superseded_by` pointed at the now-deleted
  Doco rename Action. Changed lifecycle to `abandoned` with a clear
  reason; no broken reference.
- The Aligno brand-assets Action's `abandoned_reason` mentioned the
  deleted Doco rename. Rewrote to drop the dead reference.

## Why

The cost of a clean technical rename — building a migration tool with
dry-run + rollback, bumping schema_version 0.1 → 1.0 per ADR-050,
rewriting ~125 entity files, renaming all 10 packages, updating env
vars across all dev environments — isn't worth it when the brand
already reads "Doco" everywhere a user looks. The dissonance between
brand and implementation is acceptable as a permanent state.

## Generalization

Adding things to the backlog is cheap; the items linger. This Action
is a reminder that *removing* from the backlog is a real move — it
clarifies the roadmap and frees the imagination from "we should
eventually do that." Anything queued that turns out not to be worth
doing should be deleted with the same lightness it was queued with.
