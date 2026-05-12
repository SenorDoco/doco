---
id: action_01KR90QEHWC22057MP3WFB2N0W
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: remove single-Doco mode entirely. Local solo is the only deployable shape; hosted multi-tenant (Principals, auth, /<owner>/<doco>/ URLs) gets paused as a separate track until there's actual demand."

actor_id: torrenegra
verb: remove_single_mode_collapse_to_local_only

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  founder_direction: |
    "Add to backlog: remove single mode."

    Triggered by the realization that the dual-mode design (single-Doco
    vs host) was built ahead of demand. For local solo development we
    don't need: Principals, owner_id, authentication, sign-up/sign-in,
    invitation tokens, claim flow, /<owner>/<doco>/ URL prefix, or the
    `host.yaml` + `docos/<owner>/<slug>/` layout. The "host" word itself
    sounds like infrastructure for what is really just a folder of folders.

  context: |
    Every feature has been landing twice — once for single-Doco, once for
    host mode. Phase 20 made this explicit when the scope tree view, the
    "+ New scope" button, and the "+ Add child scope" link only landed in
    host mode. Phase 21 (the modes-collapse) was originally framed as
    "make local-dev look like host-of-one." The user reframed: drop the
    host-shape concepts entirely from the local model; the hosted
    multi-tenant track becomes its own future Phase, not a default-on
    assumption.

what_to_do:
  - "Drop /onboarding/* routes (sign-in, sign-up, claim, invite, agent-create)."
  - "Drop @doco/api auth + sessions + invitation/redemption code."
  - "Drop Principal entity type from schema (or shrink to advisory string)."
  - "Drop Organization entity type."
  - "Drop owner_id from Doco; the workspace-implicit user authors everything."
  - "Drop /<owner>/<doco>/ URL prefix; URLs become /<doco-slug>/... (or just / when there's one)."
  - "Drop host.yaml; workspace is implicit from a folder containing zero or more `<slug>/doco.yaml` Docos."
  - "Rename `host` → `workspace` everywhere it survives, OR drop the term and just call it 'a folder of Docos'."
  - "Mark superseded: ADR-037, ADR-038, ADR-061, ADR-062, ADR-063, ADR-066, ADR-067, ADR-068, ADR-069, ADR-070, ADR-071, ADR-073 (auth + multi-tenant). Don't delete the entities — flip lifecycle to `superseded` so the rationale stays readable."
  - "Write ADR-085 documenting the pivot: 'Local-solo is the supported shape; hosted multi-tenant is paused.' Successor of ADR-061."
  - "actor_id on Actions becomes a free-form string (e.g., `torrenegra` or `claude-sonnet-4-5/2026-05-10/abc`) instead of a Principal id."
  - "human-ancestry-terminates-at-human invariant becomes a hosted-track concern; locally there's just one human."

risks:
  - "Lots of code deletion. Branching off main for the cut-down keeps the in-flight work clean."
  - "When hosted multi-tenant is later reintroduced, some of this design will get rebuilt. Plan: branch a `hosted-multi-tenant` track when the time comes, picking up the now-superseded ADRs as starting points."
  - "Existing meta-Doco entities have owner_id, Principal references, etc. Migration: replace with advisory strings or drop the fields entirely; preserve actor traceability via the string form."

follows:
  - decision_01KR8Z7YHGMPD7CJRGSSQG7KRV   # ADR-083 (brand cutover) — predecessor

decisions_consulted:
  - decision_01KR8Z7YHGMPD7CJRGSSQG7KRV   # ADR-083 (brand cutover)

created_at: 2026-05-10T07:00:00Z
created_by: torrenegra
revision: 2
lifecycle: succeeded
status: completed
started_at: 2026-05-12T10:00:00Z
ended_at: 2026-05-12T11:30:00Z
completion_note: |
  Shipped via ADR-087 (local-solo collapse). All bullets in
  what_to_do landed: routes deleted, packages/host removed, Principal
  + Organization entity types removed from schema, owner_id + members
  removed from doco_entity, $ownerSlug routes deleted, host CLI
  command removed, dual-mode detection collapsed, ADR-061..ADR-073
  family marked superseded.
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — remove single mode

## What

Collapse the dual-mode (single-Doco / host) design to a single
local-solo shape. Hosted multi-tenant becomes its own deferred track.
Strip Principals, authentication, owner-prefixed URLs, sign-up/sign-in
flows, invitation tokens, the claim ceremony, and the host.yaml layer
from the codebase.

## Why

Built ahead of demand. The pain shows up every time a feature has to
land twice. The local-solo workflow doesn't need the multi-tenancy
machinery; the hosted workflow is genuinely different (and not on the
near-term roadmap).

## Trigger

When the user gives the go-ahead. Until then this stays in the backlog.
Phase 21 (whenever it lands) will likely be "the deletion phase."
