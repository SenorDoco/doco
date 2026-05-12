---
id: action_01KR441EABNCVK39BSWQRGTDHX
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: reduce the logotype size relative to the isotype (icon) in the DocoMark component."

actor_id: torrenegra   # owner — to be claimed by whoever picks this up
verb: adjust_brand_mark_proportions

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0

decision_ids:
  - decision_01KR441EAAC7TMEQ2WS9DEVYA6   # ADR-056 UI theme
  - decision_01KR441EA9PY9B1V5H7JRN8DAV   # ADR-055 Remix migration

inputs:
  founder_direction: "Make the logotype smaller compared to the isotype (favico)"
  current_state: |
    `DocoMark` (packages/web/app/components/doco-mark.tsx) renders the
    favicon (square, height = H) and the logotype text (height = H,
    width ≈ 3.44H) side by side, with gap = 5% of logotype width. Both
    SVGs scale to the same height — logotype dominates the composition
    (~3.4× wider than the icon).

outputs:
  expected:
    - "Smaller logotype height relative to icon height (e.g., logotype = 0.75 × icon, or logotype scales by some other factor)"
    - "DocoMark API: maybe a `logotypeRatio` prop, or new `iconHeight` + `logotypeHeight` separately"
    - "Update header (28 px nominal), hero (128 px), dashboard (80 px) to taste"
    - "Re-verify in Chrome that proportions look balanced at all sizes"

created_at: 2026-05-09T03:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: abandoned
status: abandoned
abandoned_reason: "Backlog grooming on 2026-05-12. Founder closed the brand-polish queue: logotype/isotype proportions are not on the roadmap. Current DocoMark proportions stay as-is until a deliberate brand pass is opened."
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — make the logotype smaller compared to the isotype

A planned Action representing a known UX backlog item. Not yet implemented;
status flips to `in_progress` when someone picks it up and `completed` when
shipped.

## Convention note (provisional)

Backlog items in this Doco are tracked as Actions with
`lifecycle: proposed` / `status: planned`. The implicit convention is:
queryable via `doco query "SELECT slug, summary FROM action WHERE status =
'planned'"` (or its slug equivalent) and visible in the host's per-Doco
recent feed. If backlogs accumulate enough that a dedicated `Backlog` entity
type or list view earns its place, promote then — same pattern as the
Plan / Question entities deferred in [ADR-009](../decisions/decision_01KR441EAWNQ4ZAPG0XGA9RJZX.md).
