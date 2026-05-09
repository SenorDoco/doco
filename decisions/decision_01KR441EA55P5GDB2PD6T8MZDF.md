---
id: decision_01KR441EA55P5GDB2PD6T8MZDF
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Web app auto-detects mode by inspecting the root directory: host.yaml → host mode (lists Evalos, routes /:owner/:slug/...), evalo.yaml → single-Evalo mode (existing behavior). One codebase, two modes."

slug: web-dual-mode-host-or-single-evalo
number: "ADR-065"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "Does the web app run differently for hosts vs. single Evalos, or does it adapt at runtime?"
chosen: |
  Single web app, dual mode. At request time the loader inspects the root
  directory:
  - `host.yaml` present → host mode. Routes:
    - `/`                          → list of Evalos in the host
    - `/:owner_slug`               → User or Org page
    - `/:owner_slug/:evalo_slug`   → Evalo home (recent feed)
    - `/:owner_slug/:evalo_slug/e/:type/:id`  → entity detail
    - `/:owner_slug/:evalo_slug/lint`          → lint
    - `/:owner_slug/:evalo_slug/search`        → search
  - `evalo.yaml` at root → single-Evalo mode (existing routes, unchanged).

  The mode selection lives in a small `getMode(root)` helper in
  packages/web/app/lib/mode.ts; loaders branch on its return value.
alternatives:
  - name: Two separate web apps, separate ports
    rejected_because: "Codebase fragmentation. Same components, same DB layer, same lint engine — no reason to maintain two."
  - name: Always run host mode (migrate single-Evalo to be a one-Evalo host)
    rejected_because: "Disruptive to the framework's self-hosted meta-Evalo (which would need to migrate too). Dual-mode is strictly additive."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T18:30:00Z

created_at: 2026-05-08T18:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-065 — Web dual-mode (host or single-Evalo)

Existing single-Evalo routes stay at `/`, `/e/:type`, `/e/:type/:id`,
`/search`, `/lint`. Host-mode routes are added as new files, scoped by
`:owner_slug` and `:evalo_slug` URL params. The `getMode()` helper short-
circuits at the loader level so the mode is locked for the whole request.
