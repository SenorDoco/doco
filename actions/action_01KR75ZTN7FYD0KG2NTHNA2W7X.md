---
id: action_01KR75ZTN7FYD0KG2NTHNA2W7X
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: thorough sweep for code cleanup, better abstractions, simplification opportunities. Apply changes and test thoroughly. Cross-package — touches schema, indexer, lints, web, api, runtime."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: code_cleanup_sweep

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

inputs:
  founder_direction: |
    "Run a thorough check to find opportunities to clean up code, find
    better code abstraction, and simplify everything. Apply them and
    test thoroughly."

outputs:
  expected:
    where_to_look:
      duplicated_logic:
        - "Two entity-detail routes (e.\\$type.\\$id.tsx and \\$ownerSlug.\\$docoSlug.e.\\$type.\\$id.tsx) duplicate ~95% of the same component (header, panes, edges tables, map loader, mobile tabs). Extract a shared component."
        - "Both onboarding role-question pages (onboarding.create._index.tsx and onboarding.join._index.tsx) reuse RoleSplitPage already, but the two human-facing pages (onboarding.create.human.tsx and onboarding.join.human.tsx) duplicate copy-message-card structure."
        - "Two list routes (e.\\$type._index.tsx and \\$ownerSlug.\\$docoSlug.e.\\$type._index.tsx) — same pattern."
      naming_inconsistencies:
        - "Files still named doco-mark.tsx, lib/db.ts uses 'DOCO_ROOT' env var, lib/host.ts has HostDoco type. Per ADR-078 + the deferred Doco→Doco code rename (action_01KR6W4643E036C8MJ3Z7GEFFM, currently planned), these are intentional gaps. Decide if the cleanup sweep should touch them or stay out."
      auto_derived_edges:
        - "FIELD_TO_EDGE_TYPE lets unknown field names default to the field name. Three current edges (`inputs.assets_provided_by`, `inputs.predecessor`, `inputs.rule_migrated_to_json_dsl`) are noise from generic walking of nested objects. Consider: explicit allow-list of canonical edge types instead of auto-derivation; OR: a cleanup pass over the entity files where these were minted."
      schema_drift:
        - "Some Decision frontmatter still uses prose-only fields like `chosen: |` block-scalar text instead of structured fields. Worth auditing whether the schema's free-form parts have crystallized enough to tighten."
      shared_code:
        - "TokenStore class lives in @doco/api but is consumed by web routes. The auth/agents helpers were extracted to api/src/agents.ts in Phase 8.1 — works, but means the web depends on the api package's server-only chain (workaround: lib/redeem.server.ts, lib/tokens.server.ts). Could move the helpers to a smaller @doco/auth package."
        - "personalizedPageRank is in packages/web/app/lib/pagerank.ts but is graph-shaped logic that could live in @doco/index alongside edges/build."
        - "Lint test setup (in-memory SQLite + edges table) is duplicated for follows-cycle tests; would benefit from a shared test helper."
      tests:
        - "Coverage gaps: no unit tests for edges.ts, pagerank.ts, ftsSanitize, getPublicBaseUrl, the ScopeSelector matcher (scope.ts has a name now-clearer-after-ADR-078)."
        - "Lint tests use the meta-Doco's actual data; brittle — a content change can break a lint test even when the logic is correct. The Phase 15 follows-cycle synthetic tests are the model to follow."
      stale_documentation:
        - "SCHEMA.md still says 'Tag' and 'tagged' edge in places (mostly the diagram + table — partially updated in Phase 15 but I didn't sweep on Phase 16). Audit + fix."
        - "AGENT.md mentions the schema path as schema/doco.schema.json (correct today, fine)."

  process:
    - "1. Build a per-package inventory: lines of code, test coverage, last-touched file. (`tokei` or similar.)"
    - "2. Walk the cross-cutting concerns above; for each, decide: refactor now / leave / capture as separate Action."
    - "3. Apply the high-leverage refactors first (extract shared entity-detail component is the biggest)."
    - "4. After each refactor: pnpm -r test, pnpm doco validate, pnpm doco lint."
    - "5. Browser walkthrough of the routes touched."
    - "6. Capture the work as a sibling Action (or a few, if scope is large) when complete."

  anti_patterns_to_avoid:
    - "Don't over-extract. Two-of-something is fine; three-of-something earns abstraction."
    - "Don't rename for the sake of renaming. The Doco→Doco code rename was queued, dropped, then re-added — pick one and stop oscillating."
    - "Don't change architecture in a cleanup pass. New abstractions earn their place via a Decision, not a sweep."

created_at: 2026-05-09T19:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: proposed
status: planned
follows:
  - action_01KR74PX3E27FY526AE8AMD3HQ   # Phase 16 (most recent — this sweep would happen after the rename settles)
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Backlog — Code cleanup + abstraction sweep

A walk through the codebase looking for refactor wins. Specific
targets identified above; the sweep itself is open-ended ("find
opportunities, apply them, test thoroughly").

## High-leverage candidates spotted just now

1. **Entity-detail route duplication** — two `.tsx` files share ~95%
   of structure (the host-mode and single-Doco variants). Each got
   the 2-column-map layout in Phase 14, the backlinks card in Phase
   13, the tab UI in Phase 14 — copy-pasted. Pulling them into a
   shared `EntityDetailLayout` component would cut hundreds of lines.

2. **Auto-derived edge noise** — `inputs.*` edge types in the indexer
   come from generic ID-walking of nested objects. Decide: allow-list
   only canonical types, or sweep the source files to remove the
   accidental references.

3. **Per-package boundaries** — `@doco/api`'s server-only chain
   (better-sqlite3, hono) leaks into the web via `*.server.ts` re-
   exports. A smaller `@doco/auth` package holding TokenStore +
   addAgentPrincipal + redeemInvitation would be a cleaner seam.

4. **Test scaffolding** — synthetic in-memory SQLite setup is
   duplicated between the future `bugfix-guard` test and the existing
   `follows-cycle` tests. Extract a `setupSyntheticDb(edges)` helper.

## When to pick up

After the next user-facing feature, OR if a future change needs to
modify all three of (single-Doco entity-detail, host-mode entity-
detail, mobile tab handling). Whichever forces the issue first.

## What stays as-is

- Doco → Doco code rename: separate Action
  (action_01KR6W4643E036C8MJ3Z7GEFFM). The cleanup sweep doesn't
  override that boundary.
- Scope-as-required-on-every-node: connectivity lint stays
  warning-only and selective. The cleanup sweep doesn't tighten it.
