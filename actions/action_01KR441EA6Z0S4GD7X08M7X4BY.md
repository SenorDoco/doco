---
id: action_01KR441EA6Z0S4GD7X08M7X4BY
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Implemented Phase 7: multi-tenant host with @evalo/host package, evalo host CLI, web dual-mode + host-scoped routes; verified against /tmp/test-host with Chrome MCP."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: implement_phase

intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB   # multi-tenant-host

decision_ids:
  - decision_01KR441EA1X74DH9WBDY5Z6HQ6   # ADR-061 host concept
  - decision_01KR441EA28XBT5BRN2KMM1EDD   # ADR-062 organization entity
  - decision_01KR441EA3N0TXTKSNR3MYCKZ4   # ADR-063 owner polymorphism
  - decision_01KR441EA4W857CKWRRWZNT2NW   # ADR-064 shared owner namespace
  - decision_01KR441EA55P5GDB2PD6T8MZDF   # ADR-065 web dual-mode

inputs:
  phase: 7

outputs:
  schema_changes:
    - "schema/evalo.schema.json: id pattern + namespaced_id pattern accept 'organization' prefix"
    - "schema/evalo.schema.json: new organization_id + owner_ref definitions"
    - "schema/evalo.schema.json: evalo_entity.owner_id now $ref owner_ref (Principal | Organization)"
    - "schema/evalo.schema.json: organization_entity definition; added to oneOf"
    - "@evalo/shared: NODE_TYPES adds 'organization'; new Organization + OrganizationMember + OwnerRef types"
    - "@evalo/core paths.ts: ENTITY_DIRS adds organization → organizations/"
    - "@evalo/index migrate.ts: organization table + slug index"
    - "@evalo/index insert.ts: organization case + delete sweep"
  packages_created: [host]
  cli_added: [host_init, host_user_create, host_org_create, host_evalo_new, host_list]
  web_added:
    - "app/lib/db.ts: rootDir(), getMode(), openEvaloDb(owner, slug)"
    - "app/lib/host.ts: loadHostConfig, listUsers, listOrgs, listAllEvalos"
    - "app/components/site-header.tsx: dual-mode nav with breadcrumb"
    - "app/routes/_index.tsx: branches host vs single-Evalo"
    - "app/routes/$ownerSlug.$evaloSlug._index.tsx: per-Evalo recent feed in host"
    - "app/routes/$ownerSlug.$evaloSlug.e.$type.$id.tsx: per-Evalo entity detail"
  tests:
    host_pkg_tests: 8
    chrome_e2e_routes_verified: ["/", "/alice/personal-research", "/anthropic/internal-policies"]

started_at: 2026-05-08T18:30:00Z
ended_at: 2026-05-08T19:30:00Z

created_at: 2026-05-08T19:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 7 — multi-tenant host

End-to-end demo against a fresh host at `/tmp/test-host`:

```
$ evalo host init /tmp/test-host --name "Local Test Host" --owner-username torrenegra --owner-email a@torre.ai
$ evalo host user create alice --email alice@example.com
$ evalo host user create bob --email bob@example.com
$ evalo host org create anthropic --owner alice --description "AI safety company"
$ evalo host evalo new alice/personal-research
$ evalo host evalo new anthropic/internal-policies
$ evalo host list
  Users (3): torrenegra, alice, bob
  Organizations (1): anthropic
  Evalos (2):
    alice/personal-research        principal → evalo_…
    anthropic/internal-policies    organization → evalo_…
```

Web (Remix dev pointed at `/tmp/test-host` via `EVALO_ROOT`) renders:
- `/` — host home with Evalos table + Users + Orgs panels
- `/:owner/:evalo` — per-Evalo recent feed (empty state for fresh Evalos)

Single-Evalo mode at `/Users/torrenegra/Evalo` continues to work unchanged
when `EVALO_ROOT` points at a directory containing `evalo.yaml`.

## Deferred for follow-up phases

- Per-Evalo list view (`/:owner/:evalo/e/:type`) and search/lint inside an
  Evalo. Phase 8 — host UX polish.
- User and Org profile pages (`/:slug` showing their Evalos).
- ADR-064 reserved-slug list (currently no protection if a User picks
  `e`, `host`, `api`, etc. as a username — should be enforced in
  addPrincipal/addOrganization).
- Migration tool: convert an existing single-Evalo into a host with one
  Evalo inside.
- Cross-Evalo search across the whole host.
