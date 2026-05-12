---
id: action_01KR441EAXS1GPG6CQH75EECD2
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Added Doco brand identity to the web UI: favicon (icon-only), wordmark (icon + 'Doco' text), and a hero on the home page."

actor_id: claude-opus-4-7
verb: add_brand_identity

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EAAC7TMEQ2WS9DEVYA6   # ADR-056 UI theme = light + Ubuntu Mono
  - decision_01KR441EA9PY9B1V5H7JRN8DAV   # ADR-055 Remix migration

inputs:
  brand_color: "#707A23"
  assets_provided_by: torrenegra
  asset_kind:
    - "icon-only SVG (graph-of-circles motif, 200×200)"
    - "wordmark SVG (icon + 'Doco' text, 1012×247)"

outputs:
  files_added:
    - packages/web/public/favicon.svg
    - packages/web/public/wordmark.svg
    - packages/web/app/components/logo.tsx   # currentColor-themed inline icon (kept for future card / chip uses)
  files_changed:
    - packages/web/app/root.tsx              # links() exports favicon
    - packages/web/app/components/site-header.tsx  # wordmark replaces text "Doco"
    - packages/web/app/routes/_index.tsx     # hero section with wordmark on home
  e2e_verification:
    favicon_url: "http://127.0.0.1:5173/favicon.svg → HTTP 200, image/svg+xml"
    wordmark_url: "http://127.0.0.1:5173/wordmark.svg → HTTP 200, image/svg+xml"
    header_logo_height_px: 25
    hero_logo_height_px: 70

started_at: 2026-05-08T18:15:00Z
ended_at: 2026-05-08T18:25:00Z

created_at: 2026-05-08T18:25:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Add Doco brand identity to the web UI

Two SVG assets shipped in `packages/web/public/`. The wordmark uses the
brand olive `#707A23`; the icon-only Logo component uses `currentColor` so
future contextual uses (e.g., inline in chips or cards) pick up theme tokens.

Verified live in Chrome via getComputedStyle / DOM inspection.
