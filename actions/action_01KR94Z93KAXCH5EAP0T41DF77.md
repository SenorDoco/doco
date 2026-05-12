---
id: action_01KR94Z93KAXCH5EAP0T41DF77
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: make createDocoInHost atomic. Today if any write after mkdir throws, the directory exists in a half-created state and blocks retries with a misleading 'already exists' error."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: make_create_doco_in_host_atomic

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  context: |
    Surfaced during Phase 21 when a parallel agent's session failed mid-create
    because the Phase 20 migration left schema/evalo.schema.json instead of
    doco.schema.json on the test host. The schema-miss caused copyFile to
    throw, leaving the Doco directory partially created (subdirs but no
    doco.yaml). Subsequent attempts hit "Doco already exists at …" — an
    accurate but misleading error.

what_to_do:
  - "Wrap the mkdir + copyFile + writeFile sequence in createDocoInHost so a thrown error rolls back the directory creation (rmdir on failure)."
  - "Or: change the existence check to inspect for the presence of doco.yaml specifically — empty subdir-only state isn't an existing Doco."
  - "Add a test in @doco/host that simulates a copyFile failure (e.g., point at a missing schema source) and asserts the directory is gone after the throw."

risks:
  - "rmdir-on-failure could mask other concurrent writes to the same dir. Single-user local-mode is fine; revisit if hosted multi-tenant lands."
  - "The 'check for doco.yaml' approach allows retrying half-created dirs cleanly but doesn't roll back. Pick one — don't do both."

follows:
  - action_01KR94Z93K39KH3894E4T63K80   # Phase 21 (where this surfaced)

decisions_consulted:
  - decision_01KR8Z7YHGMPD7CJRGSSQG7KRV   # ADR-083 (Phase 20 brand cutover; the migration miss originated here)

created_at: 2026-05-10T08:30:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: proposed
status: planned
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — atomic createDocoInHost

## Why

When `createDocoInHost` partially fails (e.g., `copyFile(hostSchemaPath, …)`
throws because the host's schema file is missing or unreadable), the
freshly-created directory and its empty subdirs (`actions/`, `decisions/`,
…) are left on disk. The next attempt at the same slug hits an
`existsSync(dir)` check and bails with "Doco already exists at …" —
which is technically true but misleading: the Doco isn't actually
created, just its skeleton.

## Trigger

When the user gives the go-ahead. Surfaced during Phase 21; user hasn't
weighed in on whether to ship the fix or leave it.

## Two reasonable paths

1. **Roll back on failure**: try/catch the mkdir+copy+write block; on
   throw, `rm -rf` the partial dir before rethrowing.
2. **Detect half-states**: change the "already exists" check to look for
   `doco.yaml` specifically. An empty-subdirs dir with no `doco.yaml`
   isn't an existing Doco — clean it up and proceed.

Either works. The first is simpler; the second is more forgiving when
something other than `createDocoInHost` left the dir behind.
