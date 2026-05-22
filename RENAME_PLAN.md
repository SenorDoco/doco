# Doco Rename Plan — neurons / synapses / primitives / collaborators

Status: design draft, awaiting project-owner sign-off.
Scope: single PR, atomic across DB schema + migration, code, route URLs, copy, on-disk fixtures.
Backward compatibility: none (alpha; per `rule_01KRKQDHWNWJAF4YKTMCB2A0D9`).

---

## 1. TL;DR

- Rename the vocabulary across the repo so the model reads as a brain (neurons + synapses) governed by primitives, with collaborators as the OAuth identity layer.
- Split the existing `Principal` entity into two orthogonal concepts: **Collaborator** (OAuth identity — `github_id`, tokens, sessions) and **Principal** (documented role/persona — `username`, `display_name`, used by `actor_id`/`actors[]`).
- Reclassify constitution articles out of the neuron graph: `guidance_article` and `node_authoring_article` become primitives (`guidance_primitive`, `neuron_authoring_primitive`) — first-class but not part of the knowledge graph.
- Move forward-only with one migration that renames tables, columns, ID prefixes, audit-op enum values, and rewrites every embedded reference in `raw_yaml` / JSONB. No back-compat shims, no dual-name URLs.
- Land the entire patch in a single reviewable PR; the plan is reviewed first.

---

## 2. The categorization

Five top-level categories. Every persisted thing in Doco belongs to exactly one. This replaces the prior model where everything was a "node type" and articles were tagged-but-excluded nodes.

| Category | Members (count) | Role | Persistence |
|---|---|---|---|
| **Neurons** (10) | `intent`, `idea`, `rule`, `decision`, `action`, `log`, `eval`, `reference`, `state`, `principal` | Knowledge-graph entities. Connect to each other via synapses. `principal` is the documented role/persona (NOT the OAuth identity). | One table per type. Indexed in `entity_fts_neurons`. |
| **Primitives** (2) | `guidance_primitive`, `neuron_authoring_primitive` | Constitution metadata. Govern how neurons may be authored. NOT on the neuron graph; do not appear as endpoints of synapses. | Tables `guidance_primitives`, `neuron_authoring_primitives` (plus org variants). Indexed in `entity_fts_primitives`. |
| **Collaborators** (1) | `collaborator` (`kind: "person" \| "agent"`) | OAuth identity layer. Carries `github_id`, `github_login`, `email`, tokens, session state. Owns audit `created_by` references. | New table `collaborators`. Indexed in `entity_fts_collaborators`. |
| **Docos** (1) | `doco` | Workspace container. | Table `docos`. Indexed in `entity_fts_docos`. |
| **Organizations** (1) | `organization` | Org container. | Table `organizations`. Indexed in `entity_fts_organizations`. |

Total: 15 distinct entity types across 5 categories (was: 14 in 2 categories).

---

## 3. Vocabulary changes (token table)

Apply only when the token refers to the graph/constitution concept — preserve Node.js, CSS edges, edge cases, etc.

| Old | New | Notes |
|---|---|---|
| node (the entity-graph noun) | neuron | Don't touch Node.js, `node_modules`, runtime paths. |
| edge (the graph-relationship noun) | synapse | Don't touch CSS, edge cases, `borderEdge`. |
| article (the constitution unit) | primitive | Clean — no false positives in this repo. |
| `node_type` (field name) | `neuron_type` | Discriminator on every neuron. |
| `article_type` (field name) | `primitive_kind` | Values: `"guidance"`, `"neuron_authoring"`. |
| `NODE_TYPES` (TS const) | `NEURON_TYPES` + new `PRIMITIVE_TYPES` | See §7. |
| `auto_edges` (frontmatter field) | `auto_synapses` | Field name + nested keys (`edge_type` → `synapse_type`). |
| `allowed_node_types` (Doco column) | `allowed_neuron_types` | |
| `default_node_lifecycle` (Doco column) | `default_neuron_lifecycle` | |
| `fires_when_node_lifecycle` (Rule/predicate) | `fires_when_neuron_lifecycle` | |
| `when_node_type`, `target_node_type`, `incoming_node_type` (predicate fields) | `when_neuron_type`, `target_neuron_type`, `incoming_neuron_type` | |
| `requires_edge`, `forbids_edge` (predicate `kind` values) | `requires_synapse`, `forbids_synapse` | |
| `edge_type` (predicate + synapse column) | `synapse_type` | |
| `'edge.add'` (audit-op enum value) | `'synapse.add'` | |
| `principal` (the OAuth-identity concept) | `collaborator` (new entity type) | See §4 — major restructure. |
| `principal` (the documented role/persona) | `principal` | Stays. Role-string remains (e.g., `"customer-service-rep"`, `"system"`). |
| `principals` (the database table) | (a) `collaborators` (new, OAuth-only) + (b) `principals` (existing, role-only fields) | Reference-driven split during migration. |
| `member` (Doco/Org member field) | `member` | Field name OK but the FK changes: `principal_id` → `collaborator_id`. Synapse type stays `member_of`. |
| `doco`, `organization`, `host` | (unchanged) | "doco" stays; `/constitution` URL stays. |
| `serves`, `has_parent`, `member_of`, `enacts`, `superseded_by`, `born_from`, `follows`, etc. (synapse-type values) | (unchanged) | Domain-concept words — keep. |

---

## 4. The collaborator split (most consequential change)

### 4.1 Why split

The current `principals` table is overloaded: it stores GitHub OAuth identity for actual users/agents AND it stores documented role-personas (e.g., the principal that an `Action.actor_id` references when the actor is `"system"` or `"customer-service-rep"`). The two concepts have nothing to do with each other:

- A *collaborator* is a real GitHub-authenticated user or an agent runtime that holds tokens. It mints sessions, receives audit attribution, can be invited and revoked.
- A *principal* is a documented role on the doco — a noun in the design language. An Action with `actor_id: principal_<system-id>` is making a design statement about what system actor performs the step. Whether that role corresponds to a real OAuth user is incidental.

### 4.2 The orthogonal model

After the rename:

- A collaborator may exist with no principal counterpart (a real user who is documented only via `created_by`, never as an actor in a flow).
- A principal may exist with no collaborator counterpart (a role-persona like `"system"` that never logs in).
- Both may exist for the same human (e.g., the founder is a real collaborator AND is documented as a `principal` who appears in `actors[]`).
- There is NO required FK between collaborator and principal. Linking them, if useful, is editorial — a future synapse type, not a hard reference.

### 4.3 Reference semantics — what changes

| Reference | Old target | New target |
|---|---|---|
| `CommonFields.created_by` on every entity | `EntityId<"principal">` | `EntityId<"collaborator">` |
| `CommonFields.updated_by` on every entity | `EntityId<"principal">` | `EntityId<"collaborator">` |
| `Action.actor_id` | `EntityId<"principal">` | `EntityId<"principal">` (unchanged) |
| `Log.actor_id` | `EntityId<"principal">` | `EntityId<"principal">` (unchanged) |
| `Intent.actors[]`, `Intent.stakeholders[]` | `EntityId<"principal">[]` | `EntityId<"principal">[]` (unchanged) |
| `Decision.decided_by` | `EntityId<"principal">` | `EntityId<"collaborator">` (this is a recorded human/agent act, not a role) |
| `Idea.proposer_id` | `EntityId<"principal">` | `EntityId<"collaborator">` |
| `Doco.members[].principal_id` | `EntityId<"principal">` | `Doco.members[].collaborator_id: EntityId<"collaborator">` |
| `Doco.owner_id` (when person/agent variant) | `EntityId<"principal">` | `EntityId<"collaborator">` |
| `Organization.members[].principal_id` | `EntityId<"principal">` | `Organization.members[].collaborator_id: EntityId<"collaborator">` |
| `oauth_*.principal_id` columns | principal FK | `collaborator_id` FK |
| `doco_users.principal_id` | principal FK | `collaborator_id` FK |
| `org_users.principal_id` | principal FK | `collaborator_id` FK |
| `member_of` synapse derivation | `Doco/Org.members[].principal_id` → org/doco | `Doco/Org.members[].collaborator_id` → org/doco. Now `collaborator → organization` |
| `audit_events.by_principal` column | `principals.id` | `collaborators.id` (column renames to `by_collaborator`) |

`Principal.username` keeps holding role-strings: `"system"`, `"customer-service-rep"`, `"torrenegra"` (when torrenegra appears as an *actor* in a flow). `Collaborator.github_login` holds login-strings: `"torrenegra"` as a GitHub identity.

### 4.4 The Collaborator entity (new shape)

```ts
export interface Collaborator {
  id: EntityId<"collaborator">;
  // Collaborators are host-scoped, not Doco-scoped, so no doco_id.
  kind: "person" | "agent";
  github_id?: string;            // GitHub numeric id (immutable across logins)
  github_login: string;          // current GitHub login (mutable)
  email?: string;                // GitHub-provided email
  avatar_url?: string;
  owner_id?: EntityId<"collaborator">;   // for agents: which person spawned this
  agent_metadata?: AgentMetadata;        // provider, model, capabilities, created_at
  created_at: string;
  // No created_by — the bootstrap collaborator is self-created; the rest are
  // created either via OAuth signup or by an existing collaborator's session.
  deactivated_at?: string;
}
```

### 4.5 The Principal entity (slimmed)

```ts
export interface Principal extends SummarizedFields {
  neuron_type: "principal";
  username: string;        // role string; e.g., "system", "customer-service-rep"
  display_name?: string;   // optional readable name when role is documented (D-018 cousin)
  description?: string;    // role description: "performs the checkout step on behalf of users"
  // No github_identity, no agent_metadata, no owner_id. Those moved to Collaborator.
  // created_by points to a Collaborator (per §4.3).
}
```

---

## 5. Migration approach

### 5.1 One forward-only migration

File: `/Users/torrenegra/Doco/packages/db/migrations/005_neurons_synapses_primitives_collaborators.sql`.
Wrapped in a transaction by the runner. Statements guarded with `IF EXISTS` / `IF NOT EXISTS` so partial-failure replay is safe. Sentinel row in `doco_meta` keyed `rename_v005` short-circuits on re-run.

### 5.2 Reference-driven split for the `principals` table

For every row in the current `principals` table, decide its fate by inspecting what currently references it (live in `raw_yaml` JSONB across all entity tables, plus the audit/OAuth tables).

| Existing row state | Migration action |
|---|---|
| OAuth-backed (`type IN ('person','agent')` + has GitHub identity), referenced only via `created_by` / `updated_by` / `oauth_*.principal_id` / `doco_users` / `org_users` | **Collaborator**. Insert into `collaborators` with same ULID but `collaborator_` prefix. Delete original `principals` row. Rewrite every `created_by` / `updated_by` / FK reference from `principal_<ulid>` → `collaborator_<ulid>`. |
| Abstract role (`username` like `"system"`, no `github_login`), referenced via `actor_id` / `actors[]` / `decided_by` / `proposer_id` / `stakeholders` | **Principal** (neuron). Stays in `principals` table. References unchanged. Field `created_by` rewrites to point at the bootstrap collaborator (if the row had `created_by` referring to itself or another principal, it's reassigned to the matching collaborator). |
| OAuth-backed AND referenced as actor in flows (e.g., torrenegra documented in actors[] as a designed role) | **Both**. (1) Create a `collaborators` row carrying the OAuth fields. (2) Keep the `principals` row, stripped of OAuth fields, carrying the role/persona fields. `actor_id` references stay; `created_by` references rewrite. |
| OAuth-backed, referenced by neither (e.g., a collaborator who logged in but did nothing) | **Collaborator** only. |
| Abstract role, referenced by neither (orphan) | Drop. Flag in migration log. |

### 5.3 ID-prefix rewrites — primary keys

| Old prefix | New prefix |
|---|---|
| `guidance_article_<ulid>` | `guidance_primitive_<ulid>` |
| `node_authoring_article_<ulid>` | `neuron_authoring_primitive_<ulid>` |
| `principal_<ulid>` (when row migrates to collaborators) | `collaborator_<ulid>` |
| `principal_<ulid>` (when row stays as a role-principal) | `principal_<ulid>` (unchanged) |
| `principal_<ulid>` (the dual-residence rows) | both prefixes coexist; original ULID kept for the principal, new ULID minted for the collaborator (to avoid PK collision between the two tables IF/when they ever federate) — OR — same ULID kept on both, distinguished only by prefix. **Recommendation: keep same ULID, distinguish by prefix.** |

### 5.4 Embedded-reference rewrites in `raw_yaml` / JSONB

Every table with a `raw_yaml` column gets two passes of `regexp_replace` on the JSON text:

1. Prefix rewrites for the two primitive prefixes (`guidance_article_` → `guidance_primitive_`; `node_authoring_article_` → `neuron_authoring_primitive_`).
2. Conditional rewrites for principal IDs that migrated to collaborator: any `principal_<ulid>` reference appearing in the context of an OAuth/created-by field gets the prefix swapped to `collaborator_<ulid>`. Fields to rewrite: `created_by`, `updated_by`, `decided_by`, `proposer_id`, `owner_id` (when it points at an identity-shaped principal), `members[].principal_id` (becomes `members[].collaborator_id`).

For JSONB columns (`audit_events.before_json`, `audit_events.after_json`, `synapses.synapse_props_json`), apply the same regex on `text` cast then re-cast to `jsonb`.

The `neuron_type` field name rewrites everywhere from `node_type` → `neuron_type` via a JSONB key-rename pass.

### 5.5 Synapse rebuild (avoidance)

The `synapses` table (renamed from `edges`) is **derived** — D-017 fields-as-edges. Two options:

- (a) Rewrite the prefix and key changes in-place against the existing rows (faster, but more careful SQL).
- (b) `TRUNCATE synapses` and call the indexer to rebuild from `raw_yaml` after the YAML has been rewritten (slower at migration time, but provably consistent).

**Recommendation: (b)** — the rebuild is O(neurons + primitives) and runs once. It's defensive against any drift introduced by the rewrites.

### 5.6 Order within the migration

1. Begin tx + sentinel check.
2. Rename tables (`edges → synapses`, `guidance_articles → guidance_primitives`, `node_authoring_articles → neuron_authoring_primitives`, plus the four org variants).
3. Rename columns (`edge_type → synapse_type`, `from_node_type → from_neuron_type`, etc.; `allowed_node_types → allowed_neuron_types`).
4. Rename indexes and PK/CHECK constraints.
5. Create new tables: `collaborators`, plus five FTS tables (see §6).
6. Apply the reference-driven principal split (§5.2) — inserts into `collaborators`, deletes/updates in `principals`.
7. ID-prefix rewrites on all PK columns and FK columns (`embeddings.entity_id`, `audit_events.entity_id`, `synapses.from_id`/`to_id`, etc.).
8. `raw_yaml` / JSONB regex passes (§5.4).
9. Rewrite `audit_events.op = 'edge.add'` to `'synapse.add'`; update CHECK constraint.
10. Rename `audit_events.by_principal` → `audit_events.by_collaborator`.
11. Rewrite `oauth_*.principal_id` → `oauth_*.collaborator_id`; rename indexes.
12. Rewrite `doco_users.principal_id` → `doco_users.collaborator_id`; same for `org_users`.
13. Truncate `synapses` and trigger a reindex pass (handled by the migration runner calling into `indexer.ts` post-script — OR — emit a row into `doco_meta` flagging "reindex_pending" that startup picks up).
14. Sentinel write.

---

## 6. DB changes

### 6.1 Table renames

| Old | New |
|---|---|
| `edges` | `synapses` |
| `guidance_articles` | `guidance_primitives` |
| `node_authoring_articles` | `neuron_authoring_primitives` |
| `org_guidance_articles` | `org_guidance_primitives` |
| `org_node_authoring_articles` | `org_neuron_authoring_primitives` |

### 6.2 New tables

`collaborators`:

```sql
CREATE TABLE collaborators (
  id              text PRIMARY KEY,            -- collaborator_<ulid>
  kind            text NOT NULL CHECK (kind IN ('person', 'agent')),
  github_id       text UNIQUE,                 -- immutable GitHub numeric id
  github_login    text,                        -- current GitHub login (mutable)
  email           text,
  avatar_url      text,
  owner_id        text REFERENCES collaborators(id) ON DELETE SET NULL,  -- agent → person
  raw_yaml        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
CREATE INDEX collaborators_github_login_idx ON collaborators (github_login);
CREATE INDEX collaborators_kind_idx ON collaborators (kind);
```

Five FTS tables (one per category):

```sql
CREATE TABLE entity_fts_neurons       (entity_id text PRIMARY KEY, doco_id text NOT NULL, neuron_type text NOT NULL, search_tsv tsvector NOT NULL, body_md text, ...);
CREATE TABLE entity_fts_primitives    (entity_id text PRIMARY KEY, doco_id text, org_id text, primitive_kind text NOT NULL, search_tsv tsvector NOT NULL, body_md text, ...);
CREATE TABLE entity_fts_collaborators (entity_id text PRIMARY KEY, search_tsv tsvector NOT NULL, ...);
CREATE TABLE entity_fts_docos         (entity_id text PRIMARY KEY, search_tsv tsvector NOT NULL, ...);
CREATE TABLE entity_fts_organizations (entity_id text PRIMARY KEY, search_tsv tsvector NOT NULL, ...);
```

GIN index per table on `search_tsv`. The five-table shape replaces the prior single `entity_fts` table (which carried a `node_type` discriminator). The `search.server.ts` filter logic now picks the table by category, then unions results when a query spans categories.

### 6.3 Column renames (summary)

- `synapses.edge_type` → `synapses.synapse_type`
- `synapses.from_node_type` → `synapses.from_neuron_type`; same for `to_node_type`
- `synapses.edge_props_json` → `synapses.synapse_props_json`
- `docos.allowed_node_types` → `docos.allowed_neuron_types`
- `docos.default_node_lifecycle` → `docos.default_neuron_lifecycle`
- `audit_events.by_principal` → `audit_events.by_collaborator`
- `oauth_access_tokens.principal_id` → `.collaborator_id` (+ index rename)
- `oauth_refresh_tokens.principal_id` → `.collaborator_id`
- `oauth_authorization_codes.principal_id` → `.collaborator_id` (if present)
- `oauth_device_authorizations.principal_id` → `.collaborator_id`
- `doco_users.principal_id` → `doco_users.collaborator_id`
- `org_users.principal_id` → `org_users.collaborator_id`

### 6.4 Index + constraint renames

Every `edges_*` index → `synapses_*`. Every `guidance_articles_*` / `node_authoring_articles_*` index → `*_primitives_*`. Every `oauth_*_principal_idx` → `oauth_*_collaborator_idx`. The `audit_events_op_check` CHECK swaps `'edge.add'` for `'synapse.add'`.

### 6.5 Data updates (post-rename)

- `UPDATE audit_events SET op = 'synapse.add' WHERE op = 'edge.add'`.
- `UPDATE audit_events SET entity_type = '...primitive' WHERE entity_type IN ('guidance_article','node_authoring_article')`.
- Truncate + rebuild `synapses` (§5.5 option b).

---

## 7. TypeScript surface changes

### 7.1 `packages/shared/src/branded.ts` — categorical types

Replace the flat `NODE_TYPES` with five category-aware constants:

```ts
export const NEURON_TYPES = [
  "intent", "idea", "rule", "decision", "action",
  "log", "eval", "reference", "state", "principal",
] as const;
export type NeuronType = (typeof NEURON_TYPES)[number];

export const PRIMITIVE_TYPES = ["guidance_primitive", "neuron_authoring_primitive"] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

// Discrete categories — useful when a callsite knows which it accepts.
export type CollaboratorType = "collaborator";
export type DocoType = "doco";
export type OrganizationType = "organization";

// Catch-all union for code that legitimately accepts any entity (URL parsers,
// audit log, the generic detail page).
export type EntityType = NeuronType | PrimitiveType | "collaborator" | "doco" | "organization";

export type EntityId<T extends EntityType = EntityType> = Brand<`${T}_${string}`, "EntityId">;
```

Helpers: `isNeuronType`, `isPrimitiveType`, `isEntityType`, `parseEntityId` (returns `{ type: EntityType, ulid }`).

### 7.2 `packages/shared/src/entities.ts` — interfaces

- New `Collaborator` interface (shape per §4.4). Lives outside `Entity` union — collaborators don't carry `doco_id` and aren't in the graph in the same way; consider a parallel `Identity` union: `Identity = Collaborator`.
- `Principal` slimmed (per §4.5). `neuron_type: "principal"`. Drops `github_identity`, `agent_metadata`, `owner_id`, `type` field.
- `GuidanceArticle` → `GuidancePrimitive`, `NodeAuthoringArticle` → `NeuronAuthoringPrimitive`. Both carry `primitive_kind` instead of `article_type`. Both keep `doco_id` (or `org_id` for the org variant); both are NOT in the neuron union.
- `CommonFields.created_by: EntityId<"collaborator">` (was `EntityId<"principal">`). Same for `updated_by`.
- `Decision.decided_by: EntityId<"collaborator">` (was principal).
- `Idea.proposer_id: EntityId<"collaborator">`.
- `Doco.members[].collaborator_id: EntityId<"collaborator">` (was `principal_id`). Same for `Organization.members[]`.
- `Doco.owner_id: EntityId<"collaborator"> | EntityId<"organization">` (was principal | organization).
- `AuthoringPredicate` variants: field renames per §3 token table; `kind` values `requires_edge`/`forbids_edge` become `requires_synapse`/`forbids_synapse`. `requires_field_resolves_to_principal` keeps its name and behavior (it still resolves to a Principal — the role neuron). Renaming to `_resolves_to_collaborator` would be wrong: the predicate's purpose is to require an `actor_id` to be a real principal, not an OAuth identity.
- `Entity` union: `Principal | Doco | Organization | Intent | Idea | Rule | Decision | Action | Log | Eval | Reference | State`. `GuidancePrimitive`, `NeuronAuthoringPrimitive`, `Collaborator` are NOT in this union — they're surfaced via parallel unions (`Primitive`, `Identity`) when needed.

### 7.3 File renames

| Old path | New path |
|---|---|
| `packages/index/src/edges.ts` | `packages/index/src/synapses.ts` |
| `packages/web/app/lib/node-colors.ts` | `packages/web/app/lib/neuron-colors.ts` |
| `packages/web/app/components/node-detail-drawer.tsx` | `packages/web/app/components/neuron-detail-drawer.tsx` |
| `packages/web/app/components/node-type-icon.tsx` | `packages/web/app/components/neuron-type-icon.tsx` |
| `packages/web/app/components/nodes-overview-card.tsx` | `packages/web/app/components/neurons-overview-card.tsx` |
| `packages/web/app/lib/use-new-node-ids.ts` | `packages/web/app/lib/use-new-neuron-ids.ts` |
| `packages/web/app/lib/principal-aliases.server.ts` | `packages/web/app/lib/collaborator-aliases.server.ts` (or split into both if both kinds of alias exist) |

`packages/index/src/edges.ts` becomes `synapses.ts`. Identifiers: `Edge → Synapse`, `EdgeAttribution → SynapseAttribution`, `deriveEdges → deriveSynapses`, `FIELD_TO_EDGE_TYPE → FIELD_TO_SYNAPSE_TYPE`, `AUTO_EDGES_FIELD = "auto_edges" → AUTO_SYNAPSES_FIELD = "auto_synapses"`.

### 7.4 Generic identifiers

| Old | New |
|---|---|
| `EdgeRowInput` | `SynapseRowInput` |
| `PprEdge`, `PprEdgeAttribution`, `PprNeighbor` | `PprSynapse`, `PprSynapseAttribution`, `PprNeighbor` (neighbor stays) |
| `NODE_TABLES` (in `db/src/types.ts`) | `NEURON_TABLES` + new `PRIMITIVE_TABLES` (or a flat `ENTITY_TABLES` map keyed by `EntityType`) |
| `EntityRecord.node_type` | `EntityRecord.entity_type` (since the record may be any category) |
| `OverviewGraphNode`, `OverviewGraphLink` | `OverviewGraphNeuron`, `OverviewGraphSynapse` |
| `ClaimNodeType` | `ClaimNeuronType` + `ClaimPrimitiveType` (mutability surface tracks the two separately) |
| `ArticleNodeType` (in capture.server.ts) | `PrimitiveKind` |
| `captureGuidanceArticle`, `captureNodeAuthoringArticle` | `captureGuidancePrimitive`, `captureNeuronAuthoringPrimitive` |
| `deriveArticleSummary`, `articleFullText` | `derivePrimitiveSummary`, `primitiveFullText` |

---

## 8. Route + API surface changes

### 8.1 URL renames

| Old URL | New URL |
|---|---|
| `GET/POST /:docoHandle/api/articles.json` | `GET/POST /:docoHandle/api/primitives.json` |
| `GET /:docoHandle/api/articles.txt` (dispatcher key) | `GET /:docoHandle/api/primitives.txt` |
| `GET/PATCH /:docoHandle/api/guidance_articles/:id.json` | `GET/PATCH /:docoHandle/api/guidance_primitives/:id.json` |
| `GET/PATCH /:docoHandle/api/node_authoring_articles/:id.json` | `GET/PATCH /:docoHandle/api/neuron_authoring_primitives/:id.json` |
| `GET/POST /:docoHandle/constitution/node-authoring/new` | `GET/POST /:docoHandle/constitution/neuron-authoring/new` |
| `GET/POST /:docoHandle/constitution/:nodeType/:articleId/edit` | `GET/POST /:docoHandle/constitution/:neuronType/:primitiveId/edit` |
| `GET /:docoHandle/edges` | `GET /:docoHandle/synapses` |
| `GET /:docoHandle/edges/:edgeKey` | `GET /:docoHandle/synapses/:synapseKey` |
| `GET /:docoHandle/graph-node-details.json` | `GET /:docoHandle/graph-neuron-details.json` |
| `GET/POST /orgs/:orgHandle/constitution/node-authoring/new` | `.../neuron-authoring/new` |
| `GET/POST /orgs/:orgHandle/constitution/:nodeType/:articleId/edit` | `.../:neuronType/:primitiveId/edit` |
| `GET /:docoHandle/constitution` | unchanged (constitution stays as a domain concept) |
| `GET /:docoHandle/api/principals.json` | unchanged (still creates documented role principals) |

NEW endpoints (collaborator surface):

| New URL | Purpose |
|---|---|
| `GET /:docoHandle/api/collaborators.json` | List collaborators with access to this Doco |
| `GET /api/v1/collaborators.json` | Cross-Doco listing for the calling collaborator (host-scoped) |
| `GET /me/collaborator.json` | Current-session collaborator (replaces any `/me/principal.json`) |

### 8.2 Route file renames

| Old file | New file |
|---|---|
| `$docoHandle.api.articles[.]json.tsx` | `$docoHandle.api.primitives[.]json.tsx` |
| `$docoHandle.api.guidance_articles.$id[.]json.tsx` | `$docoHandle.api.guidance_primitives.$id[.]json.tsx` |
| `$docoHandle.api.node_authoring_articles.$id[.]json.tsx` | `$docoHandle.api.neuron_authoring_primitives.$id[.]json.tsx` |
| `$docoHandle.constitution.$nodeType.$articleId.edit.tsx` | `$docoHandle.constitution.$neuronType.$primitiveId.edit.tsx` |
| `$docoHandle.constitution.node-authoring.new.tsx` | `$docoHandle.constitution.neuron-authoring.new.tsx` |
| `$docoHandle.edges._index.tsx` | `$docoHandle.synapses._index.tsx` |
| `$docoHandle.edges.$edgeKey.tsx` | `$docoHandle.synapses.$synapseKey.tsx` |
| `$docoHandle.graph-node-details[.]json.tsx` | `$docoHandle.graph-neuron-details[.]json.tsx` |
| `orgs.$orgHandle.constitution.$nodeType.$articleId.edit.tsx` | `orgs.$orgHandle.constitution.$neuronType.$primitiveId.edit.tsx` |
| `orgs.$orgHandle.constitution.node-authoring.new.tsx` | `orgs.$orgHandle.constitution.neuron-authoring.new.tsx` |
| NEW: `$docoHandle.api.collaborators[.]json.tsx` | (collaborator listing) |

### 8.3 JSON body field renames (per-endpoint)

- `POST /<handle>/api/primitives.json` request body: `article_type` → `primitive_kind`; value `"node_authoring"` → `"neuron_authoring"`.
- `GET /<handle>/api/primitives.json` response: row `article_type` → `primitive_kind`; `node_type` → `neuron_type` (or `entity_type`); IDs use new prefixes; counters `node_authoring_count` → `neuron_authoring_count`.
- `/api/v1/agent-bootstrap.json`: `guidance_articles` → `guidance_primitives`; `node_authoring_articles` → `neuron_authoring_primitives`.

---

## 9. Breaking changes for external consumers

These are surfaces that agents and bookmark holders MUST be migrated on.

| Surface | File | Change |
|---|---|---|
| `/llms.txt` | `packages/web/app/routes/llms[.]txt.tsx` | Endpoint list (`/api/articles.json` → `/api/primitives.json`); "Node types" → "Neuron types"; "Articles are not nodes" → "Primitives are not neurons"; document collaborator vs principal split. |
| `/api/v1/agent-bootstrap.json` | `packages/web/app/routes/api.v1.agent-bootstrap[.]json.tsx` | Field renames per §8.3. |
| `/protocol/canonical-instructions` | `packages/web/app/lib/instructions.server.ts` | Rewrite prose: "Articles of the Constitution" → "Primitives of the Constitution"; "12-node-type model" → "10-neuron-type model" (count changes); "edge" → "synapse" everywhere; document the principal/collaborator orthogonality; new section on "how to find your collaborator id". |
| `/protocol/agent-oauth-recipe` | `packages/web/app/routes/protocol.agent-oauth-recipe.tsx` | Rewrite: tokens belong to a collaborator (not a principal); `actor_id` in submitted neurons points at a principal (role), not the calling collaborator. |
| Senor Doco system prompt | `packages/web/app/lib/agent-chat.server.ts` | Tool descriptions; the "Adding-an-Edge" section becomes "Adding-a-Synapse"; the table of field→synapse-type; the no-direct-edges-endpoint note now says "synapses". |
| `/<handle>/constitution` HTML | `packages/web/app/routes/$docoHandle.constitution.tsx` | Page copy renames "articles" → "primitives". |
| `/<handle>/welcome` HTML | `packages/web/app/routes/$docoHandle.welcome.tsx` | "Docos are made of nodes and edges" → "Docos are made of neurons and synapses". |
| `/<handle>/api/<type>.txt` dispatcher | `packages/web/app/routes/$docoHandle.api.$type[.]txt.tsx` | `articles:` key → `primitives:`; field renames in the embedded predicate docs. |
| `/<handle>/api/<type>.json` 404 branch | `packages/web/app/routes/$docoHandle.api.$type[.]json.tsx` | Rejected names update: `guidance_primitives`/`neuron_authoring_primitives`/`collaborators` are routed differently — pointer says "use `/api/primitives.json` for primitives, `/api/collaborators.json` for collaborators". |
| `/dashboard`, `/docos`, `/orgs` UIs | various | Article-count UI → primitive-count; `entity_type IN (...)` SQL literal strings update. |
| Audit-log clients | `audit-log.server.ts`, `activity-feed.ts` | `"edge.add"` → `"synapse.add"`. The op enum visible at `/api/audit.json` changes — agents that read audit MUST update. |
| `auto_edges` writers | external agents | Field rename to `auto_synapses` + nested `edge_type` → `synapse_type`. Migration rewrites in storage; agents writing fresh must use the new name. |
| OAuth token shape | unchanged | Token strings unchanged; the principal_id claim renames to collaborator_id in any token-introspection responses (§6.3). |

External-discoverable surfaces not breaking: the OAuth metadata endpoints (`/.well-known/oauth-authorization-server`), the `/sign-in`/`/sign-out`/`/sign-up` paths, `/<handle>` index, `/<handle>/<type>/<id>` generic detail (URL shape stays, type slot accepts new values).

---

## 10. Templates + fixtures impact

### 10.1 In-tree fixtures

- `/Users/torrenegra/Doco/host.yaml` — `node_type:` → `neuron_type:` (key rename; value `host` stays as a manifest marker). Decide: keep `neuron_type: host` (consistent key) OR rename the key to `manifest_kind` for the non-graph case. **Recommendation: rename to `manifest_kind: host`** since `host` is not a neuron.
- `/Users/torrenegra/Doco/principals/principal_*.yaml` (13 files) — every file is currently a `node_type: principal` row. After the split, most of these become collaborator manifests (they carry `github_identity`). Per §5.2 they will be split:
  - Move to a new directory `/Users/torrenegra/Doco/collaborators/collaborator_*.yaml` for the OAuth-only or both-residence rows.
  - Keep in `/Users/torrenegra/Doco/principals/principal_*.yaml` only the rows that are pure role/persona (none currently exist on disk — all 13 carry `github_identity`).
  - For the dual-residence row (`principal_01KR441EA199MZCP7RDMADFZW9` — torrenegra), the CLI emits BOTH files at the same ULID with different prefixes.
- `/Users/torrenegra/Doco/docos/host-bootstrap/*/doco.yaml` (14 files) — `node_type: doco` → `neuron_type: doco` (or use `entity_type` here; see §7.4 open recommendation). `owner_id: principal_<ulid>` → `owner_id: collaborator_<ulid>`. `members[].principal_id` → `members[].collaborator_id`.
- `/Users/torrenegra/Doco/docos/host-bootstrap/me-torrenegra-com/decisions/decision_*.md` (5 files, 2 with `auto_edges`) — frontmatter `node_type:` → `neuron_type:`; `auto_edges:` → `auto_synapses:` (with `edge_type:` → `synapse_type:` inside each entry); `created_by` references rewrite to collaborator prefix.
- `/Users/torrenegra/Doco/docos/host-bootstrap/.deleted/...` — out of scope (soft-deleted snapshots).

### 10.2 Doco templates (code)

- `/Users/torrenegra/Doco/packages/host/src/doco-templates.ts` — `TemplateArticle` → `TemplatePrimitive`; `DocoTemplate.articles` → `.primitives`; `allowedNodeTypes` → `allowedNeuronTypes`; `defaultNodeLifecycle` → `defaultNeuronLifecycle`; predicate field renames; `kind: "guidance" | "tagged"` stays (this is `Rule.kind`, distinct from `primitive_kind`).
- Template seeding code in `packages/host/src/host.ts` — writes to renamed tables; ID prefix construction uses new prefixes.

### 10.3 CLI fixtures + flow

- `packages/cli/src/commands/init.ts` — emits new `neuron_type:` / `entity_type:` fields. The init flow now seeds BOTH a `collaborators/<ulid>.yaml` AND optionally a `principals/<ulid>.yaml` (when the user wants to also appear as a documented role-actor).
- `packages/cli/src/commands/export.ts` — `TYPE_TO_DIR` map: new entries for `collaborator: "collaborators"`, `guidance_primitive: "guidance_primitives"`, `neuron_authoring_primitive: "neuron_authoring_primitives"`.
- `packages/cli/src/commands/patch.ts` — same map; `TYPE_TO_PLURAL` updated.
- `packages/cli/src/commands/capture.ts` — accepted `<type>` arg now includes the new plurals.
- `packages/cli/src/commands/audit.ts` — `op === "synapse.add"` branch.

---

## 11. Execution order (phases)

Land in one PR; within the patch, the diff is structured into these phases so reviewers can read by phase. Sequencing also keeps intermediate states approximately compilable.

**Phase 1 — DB foundation (the rename's anchor).**
- Write `migrations/005_neurons_synapses_primitives_collaborators.sql`.
- Update `packages/db/src/schema.sql` to the post-rename baseline.
- Update `packages/db/src/types.ts` (NEURON_TABLES, PRIMITIVE_TABLES, COLLABORATOR_TABLES; EntityRecord shape).
- Update `packages/db/src/repo.ts`, `indexer.ts`, `embeddings.ts` (queries, column names, branchings).

**Phase 2 — Shared types (the type root).**
- `packages/shared/src/branded.ts` — NEURON_TYPES, PRIMITIVE_TYPES, EntityType union, new EntityId generic.
- `packages/shared/src/entities.ts` — new Collaborator + slimmed Principal interfaces; rename article interfaces; AuthoringPredicate field renames.
- `packages/shared/src/paths.ts` — ENTITY_DIRS additions/renames; new `collaborators/` dir.
- `packages/shared/src/url-conventions.ts` — ENTITY_TYPES + EntityUrlInput field renames.
- `packages/shared/src/loaded-doco.ts`, `refs.ts`, `files.ts` — sweep.
- Update unit tests in `packages/shared/src/__tests__/`.

**Phase 3 — Index package.**
- Rename `edges.ts` → `synapses.ts`. Update barrel.
- Update `pagerank.ts`, `loadDoco.ts`, `build.ts`.
- Update `member` derivation to read from `members[].collaborator_id`.

**Phase 4 — Host + CLI packages.**
- `packages/host/src/host.ts`, `doco-templates.ts` — template field renames; collaborator-seeding flow.
- `packages/host/src/__tests__/*` — fixture updates; TRUNCATE list updates.
- `packages/cli/src/commands/*` — TYPE_TO_DIR, TYPE_TO_PLURAL, help text, copy.
- `packages/cli/README.md`.

**Phase 5 — Web server lib (the heavy bulk).**
- `capture.server.ts` (largest file). Rename article handlers to primitive handlers; rename `nodeType` parameter to `neuronType`/`entityType`; ID prefix construction; `auto_edges` → `auto_synapses`.
- `agent-chat.server.ts` — system prompt + tool descriptions + queries against renamed tables.
- `instructions.server.ts` — full prose rewrite of canonical instructions.
- `constitution-copy.ts` — rename explainers + helpers.
- `full-graph.server.ts`, `search.server.ts`, `search-filters.server.ts`, `doco-stats.server.ts`, `mutability.server.ts`, `activity-feed.ts`, `audit-log.server.ts`, `node-colors.ts` (file rename), `agents.server.ts`, `principal-aliases.server.ts` (file rename or split), `llm.server.ts`, `redeem.server.ts`, `api-capture-factory.server.ts`, `use-new-node-ids.ts` (file rename).

**Phase 6 — Web components + routes.**
- Components: file renames (`node-*` → `neuron-*`); type prop renames; activity-feed line.
- Routes — order within: (a) primitive + edges/synapses route files (rename file paths + content), (b) dispatchers (`$type.json`, `$type.txt`), (c) per-Doco surfaces (_index, welcome, constitution, settings, activity, search), (d) org-level surfaces, (e) API v1 surfaces (agent-bootstrap, agent-chat), (f) protocol pages, (g) probe + llms.txt.
- `packages/web/app/routes.ts` — update route table with new paths.

**Phase 7 — Docs + fixtures.**
- `SCHEMA.md`, `DECISIONS.md`, `PLANNING.md`, `README.md`, `AGENTS.md`, `CLAUDE.md` — full in-place rewrite in the new vocabulary (no historical-note appending; alpha posture).
- Add a new ADR (D-NNN) recording the rename for traceability.
- `host.yaml`, `principals/*.yaml` (with the directory split per §10.1), `docos/host-bootstrap/**/*.yaml` and `*.md` — frontmatter field renames + ID prefix rewrites. The migration script does the same rewrites in storage.

**Phase 8 — Build artifacts (no manual work).**
- `packages/web/build/**`, `packages/*/dist/**`, `*.tsbuildinfo` — regenerated on next build.

The 38-step micro-order from the earlier plan is preserved in the appendix.

---

## 12. Known risks

1. **The principal split is reference-driven and editorial.** Some current `principals` rows arguably belong in both buckets. Treat the migration's classification step as auditable: emit a per-row decision log (kept in `doco_meta` or a one-off `principal_split_audit` table) so the project owner can review the split outcomes.

2. **Same-ULID collision between `principals` and `collaborators`.** When a row resides in both, the ULID is the same but the prefix differs. Code paths that compare IDs by ULID-only must continue working; code paths that compare full IDs must distinguish the prefix. Add an `assertEntityType` helper to catch silent confusion.

3. **`AuthoringPredicate.requires_field_resolves_to_principal` stays principal-targeted.** This is deliberate (it validates that an `actor_id` points at a role principal, not at a collaborator). Reviewers will be tempted to rename it; document the choice in the migration ADR.

4. **External agent breakage on audit-op enum.** The `'edge.add'` → `'synapse.add'` rename is read by every audit consumer. There is no shim. Document loudly in `llms.txt` and the protocol prose.

5. **`auto_edges` in fixtures.** The two decision_*.md fixtures carry `auto_edges:` blocks. The migration rewrites in storage; the on-disk fixtures rewrite via Phase 7. If a fresh checkout runs `doco import` before the migration runs, the YAML parser will accept both keys — confirm.

6. **`entity_fts` shape change (one table → five).** Search queries that union categories now do five-way reads. Performance should be fine (small per-table indexes; same total rows), but spot-check `/<handle>/search` and `/dashboard` queries before merge.

7. **`Doco.owner_id` polymorphism.** Currently `principal | organization`. After: `collaborator | organization`. Spot-check the `mapDocoOwner` SQL joins (`LEFT JOIN principals` becomes `LEFT JOIN collaborators` for the identity branch).

8. **Generated columns and indexes.** Postgres tracks columns by oid through RENAME — but verify the `entity_fts*.search_tsv` GIN indexes survive the table rename, and that the `tsvector` GENERATED expressions don't reference the old column name (`node_type`) which then breaks.

9. **`/constitution` URL stays, but its contents now describe primitives.** The vocabulary mismatch between "constitution" (kept) and "primitives" (new content noun) is intentional — the constitution is a collection of primitives — but document it in the page header so users don't think the page renamed.

10. **`reasoning_%` legacy cleanup in `schema.sql`.** The DO-block at the bottom that deletes legacy `reasoning_` IDs from `edges` needs the table name updated to `synapses`. It's `IF NOT EXISTS`-idempotent but the literal `edges` string is hard-coded.

11. **DECISIONS.md vocabulary.** D-008 establishes "node" as the umbrella noun. D-009/D-011/D-015/D-016/D-017/D-018 build on it. Rewriting in place erases the design history. **Recommendation: rewrite in place (alpha posture), but include a new ADR (D-NNN) that records the rename rationale.**

12. **`packages/web/app/lib/principal-aliases.server.ts`.** Inspect before renaming — if it aliases role-strings (e.g., "the system"), it stays under `principals`. If it aliases OAuth identities (e.g., "torrenegra"), it moves to `collaborators`. Likely both — split into two files.

---

## Appendix A — File inventory by category

Drawn from the earlier 66KB plan (file paths verified; categorization refreshed for the 5-category model). All paths absolute. Counts exclude `node_modules`, `dist`, `build`, `.pnpm-store`, `pnpm-lock.yaml`, `*.tsbuildinfo`. Roughly 167 files in scope.

### A.1 DB schema + types + repo + indexer (8 files)

- `/Users/torrenegra/Doco/packages/db/src/schema.sql`
- `/Users/torrenegra/Doco/packages/db/src/types.ts`
- `/Users/torrenegra/Doco/packages/db/src/repo.ts`
- `/Users/torrenegra/Doco/packages/db/src/indexer.ts`
- `/Users/torrenegra/Doco/packages/db/src/embeddings.ts`
- `/Users/torrenegra/Doco/packages/db/src/migrations.ts`
- `/Users/torrenegra/Doco/packages/db/migrations/README.md`
- `/Users/torrenegra/Doco/packages/db/src/__tests__/schema-consistency.test.ts`

### A.2 Shared package (10 files)

- `/Users/torrenegra/Doco/packages/shared/src/branded.ts`
- `/Users/torrenegra/Doco/packages/shared/src/entities.ts`
- `/Users/torrenegra/Doco/packages/shared/src/paths.ts`
- `/Users/torrenegra/Doco/packages/shared/src/url-conventions.ts`
- `/Users/torrenegra/Doco/packages/shared/src/refs.ts`
- `/Users/torrenegra/Doco/packages/shared/src/files.ts`
- `/Users/torrenegra/Doco/packages/shared/src/loaded-doco.ts`
- `/Users/torrenegra/Doco/packages/shared/src/index.ts`
- `/Users/torrenegra/Doco/packages/shared/src/__tests__/branded.test.ts`
- `/Users/torrenegra/Doco/packages/shared/src/__tests__/files.test.ts`

### A.3 Index package (5 files)

- `/Users/torrenegra/Doco/packages/index/src/edges.ts` (rename to `synapses.ts`)
- `/Users/torrenegra/Doco/packages/index/src/build.ts`
- `/Users/torrenegra/Doco/packages/index/src/loadDoco.ts`
- `/Users/torrenegra/Doco/packages/index/src/pagerank.ts`
- `/Users/torrenegra/Doco/packages/index/src/index.ts`

### A.4 Host package (6 files)

- `/Users/torrenegra/Doco/packages/host/src/host.ts`
- `/Users/torrenegra/Doco/packages/host/src/doco-templates.ts`
- `/Users/torrenegra/Doco/packages/host/src/mode.ts`
- `/Users/torrenegra/Doco/packages/host/src/__tests__/host.test.ts`
- `/Users/torrenegra/Doco/packages/host/src/__tests__/doco-templates.test.ts`
- `/Users/torrenegra/Doco/packages/host/src/__tests__/db-isolation.ts`

### A.5 CLI package (~14 files)

- `/Users/torrenegra/Doco/packages/cli/src/commands/capture.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/export.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/patch.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/init.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/show.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/audit.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/reindex.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/supersede.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/host.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/import.ts`
- `/Users/torrenegra/Doco/packages/cli/src/commands/install-agent-bootstrap.ts`
- `/Users/torrenegra/Doco/packages/cli/src/load-doco.ts`
- `/Users/torrenegra/Doco/packages/cli/src/__tests__/stop-check.test.ts`
- `/Users/torrenegra/Doco/packages/cli/README.md`

### A.6 Web server lib (~25 files)

- `/Users/torrenegra/Doco/packages/web/app/lib/capture.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/agent-chat.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/instructions.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/constitution-copy.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/full-graph.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/search.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/search-filters.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/doco-stats.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/doco-access.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/doco-templates-meta.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/mutability.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/api-capture-factory.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/agents.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/activity-feed.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/audit-log.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/node-colors.ts` → `neuron-colors.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/principal-aliases.server.ts` → split / rename
- `/Users/torrenegra/Doco/packages/web/app/lib/role-helpers.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/llm.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/redeem.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/use-new-node-ids.ts` → `use-new-neuron-ids.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/invite-store.server.ts`, `invite.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/oauth.server.ts`, `oauth-server.server.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/__tests__/doco-stats.server.test.ts`
- `/Users/torrenegra/Doco/packages/web/app/lib/__tests__/doco-access.server.test.ts`

### A.7 Web UI components (8 files)

- `/Users/torrenegra/Doco/packages/web/app/components/overview-graph.tsx`
- `/Users/torrenegra/Doco/packages/web/app/components/entity-graph.tsx`
- `/Users/torrenegra/Doco/packages/web/app/components/node-detail-drawer.tsx` → `neuron-detail-drawer.tsx`
- `/Users/torrenegra/Doco/packages/web/app/components/nodes-overview-card.tsx` → `neurons-overview-card.tsx`
- `/Users/torrenegra/Doco/packages/web/app/components/node-type-icon.tsx` → `neuron-type-icon.tsx`
- `/Users/torrenegra/Doco/packages/web/app/components/activity-feed-line.tsx`
- `/Users/torrenegra/Doco/packages/web/app/components/activity-heatmap.tsx`
- `/Users/torrenegra/Doco/packages/web/app/components/badge.tsx`

### A.8 Web routes (47 files)

Article + edges (rename path + file):
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.articles[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.guidance_articles.$id[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.node_authoring_articles.$id[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.constitution.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.constitution.guidance.new.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.constitution.node-authoring.new.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.constitution.$nodeType.$articleId.edit.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/orgs.$orgHandle.constitution.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/orgs.$orgHandle.constitution.guidance.new.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/orgs.$orgHandle.constitution.node-authoring.new.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/orgs.$orgHandle.constitution.$nodeType.$articleId.edit.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.edges._index.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.edges.$edgeKey.tsx`

Generic dispatchers (content update, possibly file rename):
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.$type[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.$type[.]txt.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.$type.$id.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.$type._index.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.graph-node-details[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle._index.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.activity.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.audit[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.principals[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.search.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.search[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.status[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.welcome.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.onboarding.agent.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.rules.new.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.invites.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.api.invites[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/$docoHandle.settings.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/api.v1.agent-bootstrap[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/api.v1.docos[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/api.v1.docos.$docoId[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/api.v1.orgs[.]json.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/api.v1.agent-chat.*.tsx` (4 files)
- `/Users/torrenegra/Doco/packages/web/app/routes/dashboard.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/docos._index.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/orgs._index.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/orgs.$orgHandle._index.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/orgs.$orgHandle.search.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/protocol.agent-oauth-recipe.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/protocol.canonical-instructions.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes/llms[.]txt.tsx`
- `/Users/torrenegra/Doco/packages/web/app/routes.ts`

### A.9 Web config (4 files)

- `/Users/torrenegra/Doco/packages/web/app/app.css`
- `/Users/torrenegra/Doco/packages/web/package.json`
- `/Users/torrenegra/Doco/packages/web/vite.config.ts`
- `/Users/torrenegra/Doco/packages/web/tsconfig.json`
- `/Users/torrenegra/Doco/packages/web/app/root.tsx`, `env.d.ts`

### A.10 Root docs (6 files)

- `/Users/torrenegra/Doco/AGENTS.md`
- `/Users/torrenegra/Doco/CLAUDE.md`
- `/Users/torrenegra/Doco/README.md`
- `/Users/torrenegra/Doco/PLANNING.md`
- `/Users/torrenegra/Doco/DECISIONS.md`
- `/Users/torrenegra/Doco/SCHEMA.md`

### A.11 Fixtures (37 files)

- `/Users/torrenegra/Doco/host.yaml`
- `/Users/torrenegra/Doco/principals/principal_*.yaml` (13 files) — most move to `/Users/torrenegra/Doco/collaborators/collaborator_*.yaml`
- `/Users/torrenegra/Doco/docos/host-bootstrap/*/doco.yaml` (14 files)
- `/Users/torrenegra/Doco/docos/torrenegra/*/doco.yaml` (2 files)
- `/Users/torrenegra/Doco/docos/host-bootstrap/me-torrenegra-com/decisions/decision_*.md` (5 files; 2 with `auto_edges` blocks)
- `/Users/torrenegra/Doco/docos/host-bootstrap/.deleted/...` — OUT OF SCOPE

---

## Appendix B — 38-step micro-order (from earlier plan, preserved)

This is the within-the-PR file-by-file edit order that keeps the codebase approximately compilable. Phases (§11) summarize; this is the detailed order.

1. Write `migrations/005_neurons_synapses_primitives_collaborators.sql`.
2. `packages/db/src/schema.sql`.
3. `packages/shared/src/branded.ts`.
4. `packages/shared/src/entities.ts`.
5. `packages/shared/src/paths.ts`.
6. `packages/shared/src/url-conventions.ts`.
7. `packages/shared/src/{loaded-doco,refs,files}.ts`.
8. `packages/shared/src/__tests__/branded.test.ts`.
9. `packages/index/src/edges.ts` → `synapses.ts`.
10. `packages/index/src/index.ts`.
11. `packages/index/src/pagerank.ts`.
12. `packages/index/src/{loadDoco,build}.ts`.
13. `packages/db/src/types.ts`.
14. `packages/db/src/{repo,indexer,embeddings}.ts`.
15. `packages/db/src/__tests__/schema-consistency.test.ts`.
16. `packages/host/src/host.ts`.
17. `packages/host/src/doco-templates.ts`.
18. `packages/host/src/__tests__/*.ts`.
19. `packages/cli/src/commands/{capture,export,patch,init,show,audit,reindex,host}.ts`.
20. `packages/cli/README.md`.
21. `packages/web/app/lib/capture.server.ts`.
22. `packages/web/app/lib/agent-chat.server.ts`.
23. `packages/web/app/lib/instructions.server.ts`.
24. `packages/web/app/lib/constitution-copy.ts`.
25. `packages/web/app/lib/full-graph.server.ts`.
26. `packages/web/app/lib/{search,search-filters}.server.ts`.
27. `packages/web/app/lib/doco-stats.server.ts`.
28. `packages/web/app/lib/mutability.server.ts`.
29. `packages/web/app/lib/{activity-feed,audit-log.server}.ts`.
30. `packages/web/app/lib/node-colors.ts` → `neuron-colors.ts`.
31. `packages/web/app/lib/{api-capture-factory,agents,doco-access,llm,redeem,role-helpers}.server.ts`.
32. `packages/web/app/lib/use-new-node-ids.ts` → `use-new-neuron-ids.ts`.
33. `packages/web/app/components/*.tsx` (rename files + content sweep).
34. `packages/web/app/routes/*.tsx` in the order: (a) articles + edges; (b) generic dispatchers; (c) dispatcher callers; (d) per-Doco surfaces; (e) org surfaces; (f) API v1; (g) protocol pages; (h) probe routes.
35. `packages/web/app/routes.ts`.
36. Root docs: `SCHEMA.md`, `DECISIONS.md` (+ new ADR), `PLANNING.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`.
37. Fixtures: `host.yaml`, `principals/*.yaml` (split into `collaborators/` + slimmed `principals/`), `docos/**/doco.yaml`, `docos/**/decision_*.md`.
38. `packages/web/build/**` — ignore (Vite regenerates).
