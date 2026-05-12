---
id: action_01KR6G9454VZM160S7HHZWBVBY
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: ship Aligno brand identity (new isotype + logotype SVGs supplied by founder). Replaces the current Doco wreath/leaf marks. Lands together with the Doco→Aligno rename."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9   # torrenegra (human, founder)
verb: stage_aligno_brand_assets

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0

decision_ids:
  - decision_01KR441EAQ1J516HMAMZ66NKRJ   # ADR-004 IDs are <node_type>_<ULID> — context: brand-only change wouldn't break this; full rename would

inputs:
  founder_direction: |
    "Add to backlog: new isotype: <inline SVG>, new logotype: <inline SVG>"
  asset_files:
    - assets/proposed-aligno-rebrand/isotype.svg     # 200×200 hexagonal node-graph mark in #707A23
    - assets/proposed-aligno-rebrand/logotype.svg    # "aligno" wordmark, 479.20×140, same #707A23

outputs:
  expected:
    files_to_replace:
      - "packages/web/public/favicon.svg            ← assets/proposed-aligno-rebrand/isotype.svg (rendered for favicon scale)"
      - "packages/web/public/logotype.svg           ← assets/proposed-aligno-rebrand/logotype.svg"
      - "packages/web/public/wordmark.svg           ← regenerate from new isotype + logotype"
      - "packages/web/app/components/doco-mark.tsx ← becomes aligno-mark.tsx; inline-SVG component swapped to the new shapes"
    site_text:
      - "All page-title 'Doco' → 'Aligno' (consequence of the rebrand Action below, not this one)"
    coupled_with:
      - action_01KR441EACS9CF3JXJBGJV019P   # the Doco→Aligno rename Action — these assets are the brand half of that work
    asset_design_notes:
      - "Isotype: 7-circle node graph (4 outer + 2 mid + 1 center) over a hexagonal-edge frame. Reads as 'aligned graph of intents/decisions/actions' — visually consistent with the framework's actual data model."
      - "Logotype: lowercase 'aligno' in geometric sans, same #707A23 (kept the project's existing brand olive). Slightly smaller than the DocoMark wordmark currently uses; revisit logotype-vs-isotype proportions when shipping (also see action_01KR441EABNCVK39BSWQRGTDHX which already calls out this proportion tweak)."

created_at: 2026-05-09T13:55:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: abandoned
status: abandoned
abandoned_reason: "Brand pivoted from Aligno to Doco. Aligno SVGs in `assets/proposed-aligno-rebrand/` are no longer the target. See action_01KR6SND6D2WBY1619QT6GJFSG (Doco visible-rename, completed). The technical-surface rename is not on the roadmap — only the user-facing brand changed. Re-confirmed abandoned 2026-05-12 alongside backlog grooming; the proposed-aligno-rebrand asset dir is now eligible for deletion."
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Backlog — Aligno brand assets ready

The founder supplied the new isotype + logotype SVGs for the post-rename
brand. Saving them in `assets/proposed-aligno-rebrand/` so they're held
in trust until the Doco→Aligno rename
([action_01KR441EACS9CF3JXJBGJV019P](action_01KR441EACS9CF3JXJBGJV019P.md))
is executed. They do not ship yet — `packages/web/public/` keeps the
Doco marks live until the rename's full migration runs.

## What's staged

| File | Notes |
|---|---|
| `assets/proposed-aligno-rebrand/isotype.svg` | 200×200, 7 nodes + 9 connecting edges in #707A23. Hexagonal frame with center node. Reads as a connected-graph metaphor — fits the framework's actual data shape. |
| `assets/proposed-aligno-rebrand/logotype.svg` | 479.20×140, lowercase "aligno" in geometric sans, same #707A23. |

## When picked up

1. Decide the live name: full rename (Doco→Aligno per
   [action_01KR441EACS9CF3JXJBGJV019P](action_01KR441EACS9CF3JXJBGJV019P.md))
   vs brand-only refresh. These assets are name-correct for "aligno", so
   shipping them under the Doco name would be wrong.
2. Move the SVGs from `assets/proposed-aligno-rebrand/` to
   `packages/web/public/`:
   - `isotype.svg` → `favicon.svg`
   - `logotype.svg` → `logotype.svg`
   - regenerate a horizontal `wordmark.svg` (isotype + logotype side by side)
3. Rename `packages/web/app/components/doco-mark.tsx` → `aligno-mark.tsx`,
   inline the new SVG shapes inside the React component. All callers
   (`SiteHeader`, `sign-in.tsx`, etc.) update by find-replace.
4. Apply the logotype-smaller-than-isotype proportion adjustment from
   [action_01KR441EABNCVK39BSWQRGTDHX](action_01KR441EABNCVK39BSWQRGTDHX.md)
   while the new shapes are in flight — single asset edit instead of two.
