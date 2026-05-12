---
id: action_01KR8Y6VSWZE3EC5K8KNW2WV4C
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 19 — edge-hierarchical scopes (ADR-081); scope purpose + guidelines + 8 curated default templates (ADR-082); existing slash-named scopes migrated; canonical agent instructions updated."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: edge_hierarchy_purpose_guidelines_defaults

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR8Y6VSS2TBQFQ2AQCXB81TK   # ADR-081
  - decision_01KR8Y6VSVWHWB8MQNM5W9WJP2   # ADR-082

follows:
  - decision_01KR8Y6VSS2TBQFQ2AQCXB81TK
  - decision_01KR8Y6VSVWHWB8MQNM5W9WJP2
  - action_01KR7ABR84RPDAVHHNZ73MA2SG     # Phase 18 (centralized bootstrap — predecessor)

inputs:
  user_direction: |
    "[Convert slash-named scopes to edge hierarchy.] Hard cutover. Also, update
    instructions on how to use scopes for user (web, API, agent instructions, etc.)
    Also, parentless scopes should include intents, too. Why do we want the scope.
    Alternatively, they can have guidelines (rules/decisions?) on how their nodes
    should be handled. For example, a scope for user flows could have guidelines
    how to look similar to BPMN. A scope for ADRs could have guidelines on what
    elements to contain. This information should be exposed to agents when they
    init a doco for the repository they are working (with 'init' I mean: an agent
    is created to start working on a project that already has doco - is there a
    better word for that?).
    The doco creation process should make the process of adding scope idiot-proof
    and should provide several defaults to chose from, such as user-flows, ADRs,
    APIs, and what else? Let's create a list of scopes would be useful to have as
    defaults."

    Three asks bundled:
    1. Replace slash-in-name with edge hierarchy. Hard cutover.
    2. Scopes carry purpose (why) + guidelines (how-to-author).
    3. Curated default scope templates make scope-setup idiot-proof.

    Side question: better word for "agent attaches to a project that already has
    a Doco"? Resolved: "onboard onto a Doco" — distinct from /onboarding/* which
    is about Principal creation.

outputs:
  source_files_changed:
    schema:
      - schema/doco.schema.json                           # Scope.name regex tightened; +purpose, +guidelines
      - packages/cli/templates/doco.schema.json           # synced
    shared:
      - packages/shared/src/entities.ts                    # Scope.purpose + Scope.guidelines fields
    host:
      - packages/host/src/scope-templates.ts               # NEW — 8 curated templates
      - packages/host/src/host.ts                          # createScopeInDoco +parentScopes/+purpose/+guidelines; parseScopeNamesInput → segments; materializeScopeTree; migrateScopesInDoco
      - packages/host/src/index.ts                         # export scope-templates
      - packages/host/src/__tests__/host.test.ts           # 4 new tests, 4 reworked
    index:
      - packages/index/src/insert.ts                       # FTS folds scope.purpose + scope.guidelines + scope.description
    api:
      - packages/api/src/server.ts                         # /api/v1/agent-bootstrap returns per-scope purpose, guidelines, parent_ids, member_count (content-only), sub_scope_count
      - packages/api/src/instructions.ts                   # canonical instructions rewritten: edge-based scopes; "read guidelines before authoring"
    web:
      - packages/web/app/lib/redeem.server.ts              # re-export materializeScopeTree, migrateScopesInDoco
      - packages/web/app/routes/$ownerSlug.$docoSlug.scopes.new.tsx  # default-template checkboxes; slash-input → segments; materializeScopeTree integration
      - packages/web/app/routes/e.$type.$id.tsx            # sub-scopes from edges (not slash matching); Purpose & guidelines card

  endpoints_changed:
    - "GET /api/v1/agent-bootstrap: scopes[] now includes `purpose`, `guidelines`, `parent_ids`, `member_count` (content-nodes only), `sub_scope_count`"

  helpers_added:
    - "createScopeInDoco({ purpose?, guidelines?, parentScopes? }) — passes new fields through to YAML"
    - "parseScopeNamesInput(text) → { valid: string[][], invalid: string[] } — splits on slashes; each `valid` entry is a segment path"
    - "materializeScopeTree({ paths, existingByName, templateForLeaf }) → { created, byName } — walks each path root → leaf, ensures each segment exists, sets parent edges"
    - "migrateScopesInDoco({ docoDir, docoId, createdBy }) → { created, renamed } — one-shot conversion of legacy slash-named scopes; idempotent"
    - "DEFAULT_SCOPE_TEMPLATES: ScopeTemplate[] (8 entries) + findScopeTemplate(name)"

  ui_changed:
    - "/scopes/new: 8 default-template checkboxes (already-existing show greyed) + custom-scopes textarea with slash-input that auto-creates parents"
    - "/e/scope/<id>: 'Purpose & guidelines' card rendered when either field is present (ADR-082)"
    - "/e/scope/<id>: sub-scopes list now from edges (parent_scope from `scopes` field) instead of slash-prefix matching"

  schema_changed:
    - "Scope.name: ^[a-z][a-z0-9_-]*(/[a-z][a-z0-9_-]*)*$ → ^[a-z][a-z0-9_-]*$ (no slashes)"
    - "+ Scope.purpose: string? (ADR-082)"
    - "+ Scope.guidelines: string? (ADR-082)"
    - "Scope.scopes semantics: now expresses parent-edge hierarchy (was: scopes-this-scope-belongs-to)"

  migration_run:
    - "alice/test10a: 3 renamed (scope1/scope11→scope11, scope1/scope111→scope111, scope4/scope41→scope41), 1 created (scope4)"
    - "host-bootstrap/phase18-rev2-test: 4 renamed, 5 created (country, france, design-system, reporter, user-flow)"

  tests_added:
    - "@doco/host: parseScopeNamesInput returns segment paths (3 cases)"
    - "@doco/host: createScopeInDoco writes purpose + guidelines + parent edges"
    - "@doco/host: materializeScopeTree creates chain from slash path; reuses existing scopes; applies template purpose/guidelines"
    - "@doco/host: migrateScopesInDoco splits slash-named scopes idempotently"

  test_status: |
    pnpm -r test → all 10 packages green:
      shared 26, core 9, cli 1, index 5, runtime 7, lints 9,
      discovery 3, api 12, host 19, web 0
    Builds: pnpm -r build → green across all packages.

constraints_observed:
  - "Hard cutover (no soft-transition release). Migration helper is idempotent."
  - "Existing scope ids preserved through migration; only names + parent edges change."
  - "No new edge type; reuses `in_scope_of`. Queries differentiate scope-vs-content via `from_node_type`."
  - "Curated defaults stay at 8 — decision-fatigue is real."
  - "Guidelines stay inline on the Scope (not split into Rule entities) — methodology recipes are advisory, not enforced."

decisions_consulted:
  - decision_01KR8Y6VSS2TBQFQ2AQCXB81TK   # ADR-081 (this Phase's ADR — edge hierarchy)
  - decision_01KR8Y6VSVWHWB8MQNM5W9WJP2   # ADR-082 (this Phase's ADR — purpose/guidelines/defaults)
  - decision_01KR76H4DAJ1ZR26ZTD69CQD8H   # ADR-079 (scope-driven discoverability — picked slash-in-name; superseded by ADR-081 for hierarchy)
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (centralized bootstrap — bootstrap response shape extends here)

started_at: 2026-05-10T05:00:00Z
ended_at: 2026-05-10T05:50:00Z

created_at: 2026-05-10T05:50:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 19 — edge-hierarchical scopes + purpose/guidelines + curated defaults

## What

Three coordinated changes turning scopes from "labels with slashes" into
the navigation primitive Doco's been describing on the side.

1. **ADR-081** — `Scope.scopes: []` becomes parent-edges. Slashes leave
   the name. Existing slash-named scopes migrated.
2. **ADR-082** — `Scope.purpose` + `Scope.guidelines` fields. Curated
   templates ship with both prefilled. Bootstrap response surfaces them.
3. **Canonical agent instructions** — agents are told to read
   `scope.guidelines` before authoring a node into the scope.

## Verification

```
$ pnpm -r build && pnpm -r test
[all green]

$ node /tmp/migrate-scopes.mjs
alice/test10a: created=1 renamed=3
  reindexed
host-bootstrap/phase18-rev2-test: created=5 renamed=4
  reindexed

$ curl -s http://127.0.0.1:8787/api/v1/agent-bootstrap | jq '.scopes[0]'
{
  "id": "scope_01KR441EA8BTTB99H928Z0NQQW",
  "name": "scope_meta",
  "summary": "...",
  "purpose": null,
  "guidelines": null,
  "parent_ids": [],
  "member_count": 136,
  "sub_scope_count": 0
}
```

End-to-end Chrome verification: `/scopes/new` renders 8 default-template
checkboxes + custom-scopes textarea; submit creates Scope entities with
prefilled purpose + guidelines; `/e/scope/<id>` shows the Purpose &
Guidelines card; sub-scope list resolves through parent edges.

## Why this is worth the migration cost

- **Renaming a parent no longer breaks children.** The relationship is
  an edge between stable ids, not a substring of a string.
- **Multi-parent works.** A `payment` scope can sit under both
  `country/france` and `concern/finance` by listing both in its
  `scopes` field.
- **Agents stop guessing.** `scope.guidelines` tells them, in the
  bootstrap response, exactly how to author into the scope. No more
  "what does `user-flows` mean here?" cold-starts.
- **Idiot-proof create.** 8 default templates cover the common cases.
  A user clicks `adrs` and `apis`; both scopes land with purpose +
  guidelines prefilled. No "what scopes should I have?" decision
  paralysis.
