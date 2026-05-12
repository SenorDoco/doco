---
id: decision_01KREMDWG6SWKFHR5P1RDB64NC
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Collapse Doco to a local-solo shape: drop Principal + Organization, drop hosted-multi-tenant routes and code paths, drop owner-prefixed URLs and host.yaml. Hosted multi-tenant is paused as a separate track; rebuild when demand materializes."

slug: local-solo-collapse
number: "ADR-087"
follows:
  - decision_01KR441EA1X74DH9WBDY5Z6HQ6   # ADR-061 (host concept; superseded)
  - decision_01KR441EA28XBT5BRN2KMM1EDD   # ADR-062 (Organization; superseded)
  - decision_01KR441EA55P5GDB2PD6T8MZDF   # ADR-065 (dual-mode detection; superseded)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "Every feature ships twice: once for single-Doco mode, once for host mode (owner-prefixed URLs + auth + Principals + Organizations). Phase 20 made this explicit when the scope tree view, the '+ New scope' button, and the '+ Add child scope' link only landed in host mode. The hosted multi-tenant model was built ahead of demand. What's the shape Doco actually ships in v0?"
chosen: |
  **Local-solo is the only deployable shape.** Hosted multi-tenant
  (Principals, Organizations, auth, sign-up/sign-in, invitations,
  claim, owner-prefixed URLs, host.yaml) is paused as a separate
  track; rebuild from this base when there's real demand.

  ### What ships in the local-solo shape

  - **One Doco per workspace folder.** `<root>/doco.yaml` marks the
    Doco; entity directories sit beside it. No nested
    `docos/<owner>/<slug>/` layout, no `host.yaml`.
  - **URLs are `/`-based.** The web maps `/` to Recent, `/e/<type>`
    to lists, `/e/<type>/<id>` to detail, `/search`, `/lint`. No
    owner-prefixed routes.
  - **Actor identity is a free-form string.** `created_by`,
    `decided_by`, `actor_id`, `author_id`, `ran_by`, `stakeholders[]`,
    `proposer_id`, `updated_by` accept any non-empty string —
    typically `<github-login>` for humans (`torrenegra`) or
    `<provider>-<model>` for agents (`claude-opus-4-7`). The runtime
    "actor.type ∈ {human, agent}" predicate uses a convention-based
    detector (`/^(claude|gpt|gemini|llama|…)-/` or contains `/` →
    agent; else human) — see runtime/src/check.ts.
  - **No auth.** No sessions, no DOCO_TOKEN, no invitations, no claim
    ceremony, no spawn-an-agent flow. Local-solo runs in the user's
    own machine; trust is implicit.
  - **Schema v0.2.** Removes `principal_entity`, `organization_entity`,
    `principal_id`, `organization_id`, `owner_ref`. Adds
    `actor_string`. The id pattern drops `principal` and
    `organization`. `Doco.owner_id` and `Doco.members[]` are removed.
    Slug pattern relaxed to allow single-segment (e.g. `my-project`)
    in addition to the legacy two-segment form.
  - **Lints reduced.** `agent-ancestry` and `pii-display-name` are
    removed (both depended on Principals). `connectivity`,
    `follows-cycle`, `orphan-reasoning`, `bugfix-guard` survive.

  ### What's superseded (kept on disk, lifecycle: superseded)

  - ADR-037, ADR-038 (token model + revocation cascade)
  - ADR-061 (multi-tenant host concept)
  - ADR-062, ADR-063 (Organization + owner_id polymorphism)
  - ADR-065 (dual-mode detection)
  - ADR-066, ADR-067 (cookie sign-in + self-service flows)
  - ADR-068..ADR-071 (agent invitation flow + spawn)
  - ADR-073 (onboarding wizard + claim)

  These stay readable so the rationale isn't lost; they're flagged
  `lifecycle: superseded` and reference this Decision via
  `superseded_by`.

  ### Migration

  A one-off Node script (`/tmp/doco-collapse-migrate.mjs`) rewrote
  322 principal-ID references across 166 entity files into string
  actor IDs, stripped `owner_id` and `members:` from doco.yaml, and
  the `principals/` + `organizations/` directories were deleted.

  ### When to reintroduce hosted multi-tenant

  When there's external demand — multiple users sharing a Doco
  remotely, third-party consumers, public-Doco URLs. Reintroduce as
  a new ADR (ADR-061-rev2 or successor) that picks up the
  vocabulary the superseded ADRs left behind. Don't merge it back
  into local-solo; ship it as a layer above (the local-solo shape
  becomes one of the host's storage backends).

alternatives:
  - name: Keep dual-mode but invest in feature parity
    rejected_because: "Phase 20 demonstrated the maintenance tax. Every UI change has to land twice. Test surface doubles. Bugs hide in the rarely-used branch. Phase 21's Recent feed, the scope LLM suggestions, and the entity-detail map all needed the dual-rendering shim. Ahead-of-demand maintenance is the most expensive kind."
  - name: Keep Principals + drop only hosted URLs
    rejected_because: "Principal entity has no purpose in local-solo — there's exactly one principal (the human in front of the machine, sometimes with an agent helping). Carrying the type just so existing entities don't need rewriting trades a one-time migration cost for forever-after schema/lint complexity."
  - name: Move hosted-multi-tenant to a feature flag
    rejected_because: "Per ADR-050 (schema versioning) and the no-backward-compat-pre-v1 principle from action_01KR6JTFDRV2GQ20DKRKKWVD93, we delete instead of feature-flag. Flags accumulate; deletions don't."
  - name: Branch a 'hosted-mt' track now
    rejected_because: "Pre-v1, no installed base. The hosted-mt code is in git history if we ever need it; a long-lived branch would rot without merges. Reintroduce from main when demand appears."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-12T11:00:00Z

created_at: 2026-05-12T11:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D   # scope_adr
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# ADR-087 — Collapse to local-solo Doco workspace

## What landed

| # | Change | Where |
|---|---|---|
| 1 | Schema v0.2: drop principal/organization defs, owner_ref, owner_id, members; relax actor fields to `actor_string`; slug allows single-segment | `schema/doco.schema.json` |
| 2 | Migration: 322 principal IDs → strings across 166 entity files; principals/ + organizations/ dirs deleted | `/tmp/doco-collapse-migrate.mjs` (one-off) |
| 3 | Deleted packages: `@doco/host` | `packages/host/` |
| 4 | Deleted routes: sign-in, sign-out, sign-up, onboarding/*, invite/*, claim/:token, agents/*, new-org, new-doco, $ownerSlug/* (8 host routes), api/suggest-scopes | `packages/web/app/routes/` |
| 5 | Deleted code: api/auth.ts, api/agents.ts, web/lib/session.ts, web/lib/redeem.server.ts, web/lib/tokens.server.ts, cli/commands/{agent,invite,host}.ts | various |
| 6 | Server rewrite: dropped auth middleware, mode branches, invitation/agents endpoints | `packages/api/src/server.ts` |
| 7 | Runtime: `actor.type` derived from string convention (no Principal lookup) | `packages/runtime/src/check.ts` |
| 8 | Lints removed: agent-ancestry, pii-display-name | `packages/lints/src/index.ts` |
| 9 | Site header rebuilt: brand+breadcrumb row, sub-bar nav (also ADR-088) | `packages/web/app/components/site-header.tsx` |
| 10 | Recent feed: live polling with append-at-bottom + off-screen-new-items badge (ADR-089) | `packages/web/app/components/recent-feed.tsx` + `routes/api.recent.tsx` |

## Risks & mitigations

- **Big delete; potential regressions** → typecheck + tests + lint all pass; meta-doco renders end-to-end.
- **Convention-based actor type detection** is fragile if model names change → easy to extend in `actorTypeFromString` as new model families ship.
- **Migration scope was 166 files** → idempotent rewrite, all 164 entities validate post-migration.

Reference: PLANNING.md will need a revision when v0.3+ work begins; for now the canonical place for the post-collapse shape is this ADR plus the schema file.
