---
id: action_01KR6VVTMYY5FAGHTN5RDATR5Y
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Bugfix: indexer was emitting self-edges from every entity's own `id` field, plus noise edges from `doco_id` (Doco membership). Both fixed in deriveEdges; reindex confirms zero self-edges and zero `id`/`doco_id` edges."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: fix_self_edge_in_indexer

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6V6W4HMM5CBJV22FD0HFSP   # ADR-075 — graph quality (this Action keeps the edges table honest)

inputs:
  user_observation: |
    Looking at a Rule's detail page, saw outgoing edges:
    - created_by → principal_... (legit)
    - doco_id → doco_... (noise, every entity has it)
    - id → rule_<self> (BUG, self-edge)
    - tagged → tag_... (legit)
    User asked: "Why is the ID considered an edge and a rule?"

outputs:
  source_files_changed:
    - packages/index/src/edges.ts   # SKIP_FIELDS = {id, doco_id}; emit() also rejects self-edges generically
  what_was_wrong:
    - "deriveEdges walked every field of an entity. The `id` field IS the entity's own id — emitted as an outbound edge to itself."
    - "`doco_id` was emitted on every entity (Doco membership). Real edge but pure noise — every entity has the same edge to its parent Doco."
    - "Bootstrap Principal `torrenegra`'s `created_by` points to itself (chicken-and-egg root). Also a self-edge, also useless."
  what_was_done:
    - "Added SKIP_FIELDS = {'id', 'doco_id'} — these never emit edges."
    - "Added a check in emit() to skip when target === fromId — catches any future self-references generically."
    - "Reindex against meta-Doco confirms zero self-edges, zero id-edges, zero doco_id-edges."

  bugfix_lint_consideration:
    - "Per ADR-021 (bugfix-guard), Decisions tagged tag_bugfix should spawn a regression Rule. This is an Action-level fix, not a Decision; no new Rule needed. The fix is minimal and the regression test is the indexer's existing build.test.ts."

started_at: 2026-05-09T17:25:00Z
ended_at: 2026-05-09T17:30:00Z

created_at: 2026-05-09T17:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA4R75QPQQ7VJMZSWKY   # tag_bugfix
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Bugfix — self-edges and Doco-membership noise

The user spotted it on a Rule's detail page: the entity had an outgoing
edge labeled `id` pointing at itself, and another labeled `doco_id`
pointing at the Doco.

`id` is the entity's own identifier; emitting it creates a self-edge
that adds zero information. `doco_id` is Doco membership — every
entity has it, so it's structural noise. Both came from `deriveEdges`
walking every field that contained an ID-shaped string.

Fix: a small `SKIP_FIELDS = {"id", "doco_id"}` set, plus a generic
`if (target === fromId) return` guard in the emit closure that catches
self-references regardless of which field they came from (the bootstrap
Principal's `created_by` was a real-world example of the latter).

After reindex:

```
$ sqlite3 .doco/cache.db "SELECT COUNT(*) FROM edges WHERE from_id = to_id"
0
```

Zero self-edges. The user-visible noise on entity-detail pages is gone.
