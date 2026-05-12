---
id: action_01KR6VVTN0D1RN6DM6G4NYG9DV
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: flip the isotype horizontally. Today the graph mark faces left; mirror it so the open node sits on the leading edge of the wordmark."

actor_id: torrenegra
verb: flip_isotype_horizontally

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  founder_direction: |
    "Add to backlog: Invert/flip isotype horizontally."
  context: |
    The current wordmark renders the favicon icon to the LEFT of the
    "Doco" text. The icon's open hexagon node is on its left side, so
    visually the icon and the text bracket the same gap. Flipping the
    icon would put the open node on the right (toward the wordmark)
    and close the visual seam.

outputs:
  expected:
    files_to_change:
      - "packages/web/public/favicon.svg — flip horizontally (transform: scale(-1, 1)) OR rewrite path data mirrored. SVG is a transform; mirror is one attribute."
      - "Verify in Chrome at every place the favicon shows: site header, signed-out home, agent-create success page."
      - "Browser favicon (the favicon shown in the tab) inherits the same SVG; verify it looks right at 16×16."
    decision_to_make:
      - "Pure CSS scaleX(-1) flip in the DocoMark component, OR rewrite the SVG so the path data is naturally mirrored. CSS is faster to ship and easy to revert. SVG rewrite is cleaner long-term but needs a designer touch."

created_at: 2026-05-09T17:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: abandoned
status: abandoned
abandoned_reason: "Backlog grooming on 2026-05-12. Founder closed the brand-polish queue: isotype orientation is not on the roadmap. Current DocoMark stays as-is until a deliberate brand pass is opened."
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — Flip isotype horizontally

Cosmetic but visually meaningful. The current isotype's open node sits on
its left side; mirroring puts it on the right, leading into the wordmark.

Quickest path: add `style={{ transform: 'scaleX(-1)' }}` to the favicon
img in `packages/web/app/components/doco-mark.tsx`. Verify also that
the browser tab favicon (loaded from `/favicon.svg` directly, not via
the React component) looks right — that one needs the SVG to be
mirrored at the asset level. Two-line change.
