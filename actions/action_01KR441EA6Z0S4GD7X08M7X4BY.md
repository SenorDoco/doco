---
id: action_01KR441EA6Z0S4GD7X08M7X4BY
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Implemented Phase 7: multi-tenant host with @doco/host package, doco host CLI, web dual-mode + host-scoped routes; verified against /tmp/test-host with Chrome MCP."

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
    - "schema/doco.schema.json: id pattern + namespaced_id pattern accept 'organization' prefix"
    - "schema/doco.schema.json: new organization_id + owner_ref definitions"
    - "schema/doco.schema.json: doco_entity.owner_id now $ref owner_ref (Principal | Organization)"
    - "schema/doco.schema.json: organization_entity definition; added to oneOf"
    - "@doco/shared: NODE_TYPES adds 'organization'; new Organization + OrganizationMember + OwnerRef types"
    - "@doco/core paths.ts: ENTITY_DIRS adds organization → organizations/"
    - "@doco/index migrate.ts: organization table + slug index"
    - "@doco/index insert.ts: organization case + delete sweep"
  packages_created: [host]
  cli_added: [host_init, host_user_create, host_org_create, host_doco_new, host_list]
  web_added:
    - "app/lib/db.ts: rootDir(), getMode(), openDocoDb(owner, slug)"
    - "app/lib/host.ts: loadHostConfig, listUsers, listOrgs, listAllDocos"
    - "app/components/site-header.tsx: dual-mode nav with breadcrumb"
    - "app/routes/_index.tsx: branches host vs single-Doco"
    - "app/routes/$ownerSlug.$docoSlug._index.tsx: per-Doco recent feed in host"
    - "app/routes/$ownerSlug.$docoSlug.e.$type.$id.tsx: per-Doco entity detail"
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
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 7 — multi-tenant host

End-to-end demo against a fresh host at `/tmp/test-host`:

```
$ doco host init /tmp/test-host --name "Local Test Host" --owner-username torrenegra --owner-email a@torre.ai
$ doco host user create alice --email alice@example.com
$ doco host user create bob --email bob@example.com
$ doco host org create anthropic --owner alice --description "AI safety company"
$ doco host doco new alice/personal-research
$ doco host doco new anthropic/internal-policies
$ doco host list
  Users (3): torrenegra, alice, bob
  Organizations (1): anthropic
  Docos (2):
    alice/personal-research        principal → doco_…
    anthropic/internal-policies    organization → doco_…
```

Web (Remix dev pointed at `/tmp/test-host` via `DOCO_ROOT`) renders:
- `/` — host home with Docos table + Users + Orgs panels
- `/:owner/:doco` — per-Doco recent feed (empty state for fresh Docos)

Single-Doco mode at `/Users/torrenegra/Doco` continues to work unchanged
when `DOCO_ROOT` points at a directory containing `doco.yaml`.

## Deferred for follow-up phases

- Per-Doco list view (`/:owner/:doco/e/:type`) and search/lint inside an
  Doco. Phase 8 — host UX polish.
- User and Org profile pages (`/:slug` showing their Docos).
- ADR-064 reserved-slug list (currently no protection if a User picks
  `e`, `host`, `api`, etc. as a username — should be enforced in
  addPrincipal/addOrganization).
- Migration tool: convert an existing single-Doco into a host with one
  Doco inside.
- Cross-Doco search across the whole host.
