---
id: decision_01KR8Y6VSVWHWB8MQNM5W9WJP2
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Scopes carry purpose (why they exist) + guidelines (how to author nodes inside them). Curated default templates make scope setup idiot-proof. Bootstrap response exposes both to agents on Doco onboarding."

slug: scopes-carry-purpose-and-guidelines
number: "ADR-082"
follows:
  - decision_01KR8Y6VSS2TBQFQ2AQCXB81TK   # ADR-081 (edge-hierarchical scopes)
  - decision_01KR7ABR811V3AQ8JG732A2DGK   # ADR-080 (centralized agent bootstrap)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "An agent onboarding to a Doco sees a list of scope names. Useful, but it doesn't tell them what each scope is for or how nodes inside it should be authored. The user asked: scopes should explain themselves and the bootstrap should expose that. Also: scope creation should be idiot-proof — pre-curated defaults the user can pick from."
chosen: |
  ### Two new optional fields on Scope

  - **`purpose`** (string) — *why* this scope exists; what kind of nodes
    belong inside it. One paragraph max.
  - **`guidelines`** (markdown string) — *how* to author nodes in this
    scope. The methodology recipe (BPMN-flavor for user-flows, ADR
    template for adrs, runbook conventions for runbooks).

  Both optional. A scope can exist with neither (especially for ad-hoc
  scopes a user creates on the fly). But every default-template scope
  ships with both prefilled.

  ### Default scope templates

  Curated set, surfaced as checkboxes on `/new-doco` redirects to
  `/scopes/new?onboarding=1` and on subsequent visits to `/scopes/new`.
  Each template prefills `name + purpose + guidelines`:

  - **`user-flows`** — BPMN-flavor: chain Actions with `follows`, branch via Decisions.
  - **`adrs`** — Architecture Decision Records: context → options → choice → consequences.
  - **`apis`** — endpoint contracts: inputs, outputs, errors, examples; `supersedes` on breaking changes.
  - **`bugs`** — report Action + fix Decision; reference each other.
  - **`runbooks`** — operational procedures: ordered Actions with `follows`; explicit rollbacks.
  - **`post-mortems`** — incident analyses: timeline → impact → root cause → prevention.
  - **`glossary`** — domain terms as References with definitions.
  - **`roadmap`** — planned work: Intent + Action with target Decisions; `follows` for sequence.

  Eight covers most projects. Optional opt-ins (not pre-checked, but
  available for later phases): `components`, `integrations`, `experiments`,
  `security`, `performance`, `migrations`. Picked up on a phase that has
  a clearer signal of demand.

  ### Where guidelines live in the data model

  Inline on the scope, not as a separate Rule entity. Two reasons:

  1. **Guidelines are advisory, not enforced.** Rules are normative —
     they're enforced by lint. Guidelines are guidance: an agent reads
     them, applies judgment, and can deviate when justified.
  2. **Guidelines belong to the scope.** Splitting them out means an
     extra fetch, extra entity, extra mental indirection. An agent
     looking up `user-flows` should get the recipe in the same response.

  Rules are still the right home for *enforcement* (`applies_to.scopes`
  is unchanged from ADR-079). The two coexist: enforcement-grade
  invariants in Rules, methodology recipes in scope.guidelines.

  ### Bootstrap exposure

  `GET /api/v1/agent-bootstrap` returns purpose + guidelines per scope.
  The canonical instructions (`packages/api/src/instructions.ts`) tell
  the agent:

  > Each scope carries a **purpose** ("why this scope exists") and
  > **guidelines** ("how to author nodes in this scope"). Before you
  > create any node into a scope, **read its guidelines.**

  This closes the loop: an agent onboarding to a Doco gets the
  methodology recipe inline with the scope it's authoring under, not as
  a separate fetch.

  ### Indexer

  `purpose + guidelines + description` are folded into the FTS body for
  scope rows so search matches on them. The `scope` SQL table keeps the
  same columns; the new fields live in `raw_json` and are read by the
  bootstrap endpoint and the scope-detail page on demand.

alternatives:
  - name: "Encode guidelines as separate Rule entities (applies_to.scopes pointing at this scope)"
    rejected_because: "Splits the methodology recipe across two entity types. Agents looking up a scope have to do a second fetch + filter to get the recipe. Plus Rules are normative; guidelines are advisory. Different kinds."
  - name: One field — call it `description` and use it for everything
    rejected_because: "`description` already exists on Scope as a generic comment. Splitting purpose (why) from guidelines (how) gives the bootstrap response a structured shape agents can query."
  - name: 20+ default templates covering every methodology
    rejected_because: "Decision fatigue at create-time. The 8 picked cover the broad strokes; specialised scopes (per-country, per-team, etc.) are project-specific and shouldn't pollute the default surface."
  - name: Render guidelines from server-rendered markdown (with full markdown styling)
    rejected_because: "Premature. Today's `<pre className=\"whitespace-pre-wrap\">` renders the markdown source readably. Add a markdown component when guidelines start having tables, code blocks that need syntax highlighting, etc."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-10T05:30:00Z

created_at: 2026-05-10T05:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-082 — Scopes carry purpose + guidelines + curated defaults

## Why

A scope's name (`user-flows`, `adrs`) tells an agent *what* the scope
contains, but not *why* it exists or *how* to author nodes inside it.
The user's framing was direct:

> Why do we want the scope[?] Alternatively, they can have guidelines
> (rules/decisions?) on how their nodes should be handled. For example,
> a scope for user flows could have guidelines how to look similar to
> BPMN. A scope for ADRs could have guidelines on what elements to
> contain.

> The doco creation process should make the process of adding scope
> idiot-proof and should provide several defaults to chose from.

Two needs: scopes should explain themselves; defaults should remove the
"what scopes do I need?" friction at create-time.

## What ships

| change | where |
|---|---|
| `Scope.purpose: string?` + `Scope.guidelines: string?` | `schema/doco.schema.json`, `packages/shared/src/entities.ts` |
| 8 curated `DEFAULT_SCOPE_TEMPLATES` (user-flows, adrs, apis, bugs, runbooks, post-mortems, glossary, roadmap) | `packages/host/src/scope-templates.ts` |
| `createScopeInDoco({ purpose?, guidelines?, parentScopes? })` | `packages/host/src/host.ts` |
| `materializeScopeTree({ templateForLeaf })` resolves leaf templates | `packages/host/src/host.ts` |
| Default-template checkboxes on `/scopes/new` (already-exists shows greyed) | `packages/web/app/routes/$ownerSlug.$docoSlug.scopes.new.tsx` |
| Bootstrap response: per-scope `purpose`, `guidelines`, `parent_ids`, `sub_scope_count` | `packages/api/src/server.ts` |
| Canonical agent instructions: "before authoring into a scope, read its guidelines" | `packages/api/src/instructions.ts` |
| Scope detail page renders Purpose + Guidelines card when present | `packages/web/app/routes/e.$type.$id.tsx` |
| FTS folds purpose + guidelines + description into the body | `packages/index/src/insert.ts` |

## What's deferred

- Markdown rendering for guidelines (currently `<pre whitespace-pre-wrap>`).
  Fine for now; bump when guidelines start using tables / fenced code.
- "More templates" expandable section (components, integrations, etc.).
  Add when usage shows demand.
- Auto-link from a member entity's render to its scope's guidelines
  ("authoring guidance: see scope.guidelines"). Useful but premature.
