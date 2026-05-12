---
id: action_01KREVB6R57P5MB474YPV2QGHK
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Fix createDocoInHost: restore the missing host-level schema file, make the create flow atomic (rollback on failure), recover from partial-create leftovers, refuse duplicates by doco.yaml not dir-existence."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: fix_create_doco_in_host_atomicity_and_schema_resolution

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  bug_report: |
    External agent tried to onboard via /onboarding/create/agent. First two
    POSTs failed with "Doco already exists at /Users/torrenegra/Evalo/docos/host-bootstrap/<slug>"
    (leftover from prior failed runs); with a guaranteed-unique slug the real
    error surfaced:

      Failed to create Doco: ENOENT: no such file or directory,
      copyfile '/Users/torrenegra/Evalo/schema/doco.schema.json'
      -> '/Users/torrenegra/Evalo/docos/host-bootstrap/<slug>/schema/doco.schema.json'

  root_cause: |
    Two issues compounded:
    1. The host's `schema/doco.schema.json` was missing — the Phase 24
       meta-doco migration moved the schema into
       `docos/torrenegra/doco/schema/` but never restored a copy at the host
       root, which `createDocoInHost` expects via `hostSchemaPath(root)`.
    2. `createDocoInHost` was non-atomic — when `copyFile` failed, the
       freshly-created directory + subdirs stayed on disk, and the
       `existsSync(dir)` check at the top of the next attempt treated that
       skeleton as "already exists", masking the real error. This is
       exactly the failure mode action_01KR94Z93KAXCH5EAP0T41DF77
       (atomic createDocoInHost) predicted; the original Action was marked
       abandoned during the local-solo collapse, but the surface came back
       with ADR-092 and the bug came with it.

outputs:
  shipped:
    code:
      - "packages/host/src/host.ts:createDocoInHost — three behavioral changes:\n  (a) 'Already exists' now checks for doco.yaml, not bare directory existence. Bare subdirs without doco.yaml are treated as recoverable leftovers and wiped before retry.\n  (b) Schema source resolution falls back to `locateSchemaTemplate()` (which finds the bundled cli template) when the host-level schema is missing — so future post-migration repos don't trip on this.\n  (c) The entire create chain (mkdir + copyFile + writeFile) is wrapped in try/catch; on any thrown error the partial dir is removed via `rm(dir, {recursive:true, force:true})` before rethrowing. The next attempt at the same slug starts clean."
      - "Restored `/Users/torrenegra/Evalo/schema/doco.schema.json` at the host root by copying from `packages/cli/templates/doco.schema.json`. Host-level schema is the primary source; the bundled template is the fallback."
    tests:
      - "packages/host/src/__tests__/host.test.ts — three new regression tests:\n  · 'retries cleanly after a partial-create leftover' — simulates a stale dir + empty subdirs, no doco.yaml; expects createDocoInHost to succeed and write a real doco.yaml.\n  · 'refuses when a real doco.yaml already exists' — preserves the duplicate-slug guardrail.\n  · 'falls back to the bundled schema template when the host has none' — covers the post-migration scenario directly."
    cleanup:
      - "Removed `/Users/torrenegra/Evalo/docos/host-bootstrap/` directory — leftover partial-create dirs from the bug-reporter agent's failed attempts."
  verification:
    - "pnpm --filter @doco/host test: 25 tests pass (was 22; +3 atomicity regression tests)."
    - "pnpm -r build: all 10 packages compile clean."
    - "doco validate --root docos/torrenegra/doco: 179 entities valid."
    - "End-to-end replay of the failed agent flow:"
    - "  POST /onboarding/create/agent doco_slug=test-12a → HTTP 200, doco.yaml written under docos/host-bootstrap/test-12a/."
    - "  Same POST again → HTTP 200 with 'already exists at <path>' (the correct, doco.yaml-backed refusal — not the false-positive that masked the original ENOENT)."
    - "  POST with a fresh slug → HTTP 200, doco.yaml written. Repeatable cleanly."

  what_did_not_change:
    - "The onboarding wizard's claim flow (claim_token handling, slug-collision UX, expired-token messaging — action_01KR6KS73SZHYSFP5RQMHRX3PA) — still scoped to a separate hardening pass."
    - "The `locateSchemaTemplate()` walk-upward fallback — still in place as a last resort; the env var and cli template paths take priority."
    - "Host bootstrapping at fresh-host time — `createHost()` still copies the schema in; only the partially-bootstrapped case is fixed."

  resurrects_action:
    - "action_01KR94Z93KAXCH5EAP0T41DF77 (atomic createDocoInHost) — marked abandoned in Phase 22's local-solo collapse, but the underlying surface is back per ADR-092. The fix here is the original Action's prescription."

created_at: 2026-05-12T19:45:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
started_at: 2026-05-12T19:30:00Z
ended_at: 2026-05-12T19:45:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Fix createDocoInHost: atomic + schema-resolution

## Reproduction (the agent's path)

```
$ curl -X POST http://127.0.0.1:5173/onboarding/create/agent \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "doco_slug=test-12a&visibility=private&agent_display_name=claude-code&model=claude-opus-4-7&provider=anthropic"
```

Before the fix: HTTP 200 with `"Failed to create Doco: ENOENT… copyfile
'/Users/torrenegra/Evalo/schema/doco.schema.json'"` rendered into the
page, plus a leftover `docos/host-bootstrap/test-12a/` directory that
blocked retries with the misleading "already exists" message.

After the fix: HTTP 200 with a real `docos/host-bootstrap/test-12a/doco.yaml`
on disk. Retrying the same slug correctly hits "already exists" backed
by an actual doco.yaml.

## Why this slipped through

Phase 24 migrated the meta-doco to host shape by moving entity dirs
into `docos/torrenegra/doco/` — including `schema/`. The migration
script never created a fresh `schema/` at the host root because the
meta-doco itself had no need for one (its agent-bootstrap reads
schemas from inside the Doco directory). `createDocoInHost`, called
when a NEW Doco is being provisioned under a different owner, still
expected the host root to carry a schema template.

Two-line fix would have been "add the host schema back." But while
the file was in there fixing the schema-source path, the atomicity
gap from the original action_01KR94Z93KAXCH5EAP0T41DF77 (abandoned in
the local-solo collapse, then resurrected when ADR-092 reverted the
collapse) became worth closing here too.
