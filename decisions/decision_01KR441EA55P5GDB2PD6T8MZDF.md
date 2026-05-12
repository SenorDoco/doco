---
id: decision_01KR441EA55P5GDB2PD6T8MZDF
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Web app auto-detects mode by inspecting the root directory: host.yaml → host mode (lists Docos, routes /:owner/:slug/...), doco.yaml → single-Doco mode (existing behavior). One codebase, two modes."

slug: web-dual-mode-host-or-single-doco
number: "ADR-065"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "Does the web app run differently for hosts vs. single Docos, or does it adapt at runtime?"
chosen: |
  Single web app, dual mode. At request time the loader inspects the root
  directory:
  - `host.yaml` present → host mode. Routes:
    - `/`                          → list of Docos in the host
    - `/:owner_slug`               → User or Org page
    - `/:owner_slug/:doco_slug`   → Doco home (recent feed)
    - `/:owner_slug/:doco_slug/e/:type/:id`  → entity detail
    - `/:owner_slug/:doco_slug/lint`          → lint
    - `/:owner_slug/:doco_slug/search`        → search
  - `doco.yaml` at root → single-Doco mode (existing routes, unchanged).

  The mode selection lives in a small `getMode(root)` helper in
  packages/web/app/lib/mode.ts; loaders branch on its return value.
alternatives:
  - name: Two separate web apps, separate ports
    rejected_because: "Codebase fragmentation. Same components, same DB layer, same lint engine — no reason to maintain two."
  - name: Always run host mode (migrate single-Doco to be a one-Doco host)
    rejected_because: "Disruptive to the framework's self-hosted meta-Doco (which would need to migrate too). Dual-mode is strictly additive."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T18:30:00Z

created_at: 2026-05-08T18:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-065 — Web dual-mode (host or single-Doco)

Existing single-Doco routes stay at `/`, `/e/:type`, `/e/:type/:id`,
`/search`, `/lint`. Host-mode routes are added as new files, scoped by
`:owner_slug` and `:doco_slug` URL params. The `getMode()` helper short-
circuits at the loader level so the mode is locked for the whole request.
