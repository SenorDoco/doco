# Post-migration simplification proposals

**Status:** Proposals (not scheduled). Written 2026-05-30 after the
doco-vnext migration (first-class edges + append-only history;
`neuron→node` / `synapse→edge`).
**Context:** A re-review of the whole codebase for "is Doco as simple and
abstract as it can be?" produced a set of changes. The behavior-preserving
ones already shipped (PRs #646, #654). The two below are **behavior-affecting**
and are written up here for a deliberate, separately-reviewed follow-up
rather than folded into a cleanup PR.

What already shipped (for reference):

- **#646** — removed the genesis-reset cutover validator and the indexer's
  computed-then-discarded edge plumbing.
- **#654** — four shared abstractions: one `appendVersion()` for node+edge
  history; one `entityTypeFromId()` helper; one `NODE_TYPE_META` registry
  (segment + prose field); one `finishNodeCapture()` scaffold extracted from
  the nine `captureX` functions.

---

## Proposal A — Collapse the two parallel history systems

### The problem

Doco currently runs **two** systems that both record who/when/what/why on a
mutation, written in the same request:

1. **`audit_events`** (pre-vnext). Per-row `before_json` / `after_json`
   diffs, an `op` enum, `by_user`, `reason`. Written via
   `appendAuditEvent()` (fire-and-forget). This is the **activity log** the
   product reads from.
2. **The vnext spine** — `changesets` (commit log: actor, source, reason,
   `tx_id`) + `node_versions` / `edge_versions` (full immutable snapshots +
   Merkle `prev_hash`/`this_hash`). Written through the `commit()` boundary.
   This powers the per-entity **History** tab, as-of reads, and tamper
   verification.

Every node create/update/retire pays for **both**. That is the redundancy.

### Why it is NOT a simple "delete one table"

The two systems **overlap; they do not duplicate**. Three asymmetries make
this a migration, not a deletion:

1. **`audit_events` is broader than the graph.** It records events the
   version spine has no row for: org/identity/membership changes,
   `lifecycle.transition` as a first-class event, and principal writes
   emitted straight from routes
   (`$docoHandle.api.principals[.]json.tsx`, `…principals.$id[.]json.tsx`).
   The spine only versions nodes and edges.

2. **The spine has no aggregate read API.** It exposes only **per-entity**
   reads — `getVersions(c, kind, entityId)` and `verifyHistory(...)`. But
   `audit_events` is read in **aggregate** shapes across ~8 sites:
   - dashboard & org activity feeds (`routes/dashboard.tsx`,
     `routes/orgs._index.tsx`, `routes/orgs.$orgHandle._index.tsx`,
     `routes/$docoHandle._index.tsx`)
   - the `/activity` route and `api/audit.json`
   - "last updated at" stats (`lib/doco-stats.server.ts`,
     `MAX(at) … GROUP BY doco_id`)
   - the approval perspective's "who proposed" join
     (`lib/approval-perspective.server.ts`, on
     `op='lifecycle.transition' AND after_json->>'lifecycle'='drafting'`)
     and node-detail history (`lib/node-detail.server.ts`)
   - Slack digests (`lib/slack.server.ts`).

3. **Diffs vs. snapshots.** `audit_events` stores the **diff**
   (`before`/`after`); the spine stores **snapshots**. Reproducing the feed
   means computing diffs from consecutive snapshots — so the feed's exact
   contents/ordering could shift. This is the part that makes it
   user-facing and worth a dedicated review.

Also stale today: the `audit_events` `op` CHECK still allows `entity.delete`
(nothing hard-deletes post-vnext — genuinely dead). Note `edge.add` is NOT
dead: it is still emitted on edge-adding node updates (see "Safe slice"
below). See "Safe slice" below.

### Target design

Make the **commit-log spine the single source of activity + history**, and
either retire `audit_events` or demote it to a thin compatibility view.

1. **Extend `changesets` to cover non-graph events** OR keep a *small*
   audit table strictly for org/identity/membership events that aren't
   nodes/edges. Decide which during design — the cleanest is: every write,
   graph or not, opens a `changeset`; node/edge writes also append a version
   row; non-graph writes carry their delta in `changesets.metadata`.
2. **Add aggregate read functions over the spine** in `packages/db`:
   - `listDocoActivity(docoId, { before, limit })` → feed rows
     (join `changesets` → version rows → entity label), newest-first,
     cursor-paginated. Replaces the per-route `SELECT … FROM audit_events`.
   - `listOrgActivity(orgId, …)` for the org dashboards.
   - `lastUpdatedAt(docoIds[])` → `MAX(recorded_at)` over `changesets`.
     Replaces `doco-stats`' `MAX(at)`.
   - a "proposed at / proposed by" lookup for the approval perspective
     (drafting transitions) — sourced from version `op`/payload +
     `changesets.actor` instead of `op='lifecycle.transition'`.
3. **Re-point the ~8 read sites** at the new functions (one module at a
   time — `audit-log.server.ts` becomes a thin adapter so callers change
   minimally).
4. **Remove the `audit_events` dual write** once every reader is migrated.
5. **Migration:** the genesis reset means there is no historical
   `audit_events` data to backfill in any live environment — the cutover is
   a code change, not a data migration. Confirm before relying on it.

### Risk & verification

- **Risk:** the activity feed is user-facing; its contents/ordering may
  change subtly when sourced from snapshots+commit-log instead of diffs.
  This is the reason it is a standalone, reviewed PR.
- **Verify:** unit-test each new aggregate query; diff the rendered feed
  before/after on a seeded Doco (drive `https://doco.to` with a dev-signin
  session per AGENTS.md, or local Postgres); run the existing
  `vnext-smoke` / `vnext-verify-test` to confirm the spine writes are
  unchanged.

### Safe slice that can land independently (low risk)

**Caution — narrower than first thought (verified 2026-05-31).** Of the two
`op` values once assumed dead, only **`entity.delete`** is actually unwritten
(no hard deletes post-vnext; the remaining references are display/filter
lists). **`edge.add` is still LIVE** — `emitAuditForUpdate` in
`capture.server.ts` (~line 665) sets `op = "edge.add"` when a node update's
patch only adds `intent_ids` edges, and emits it via `appendAuditEvent`.
Trimming `edge.add` from the CHECK would reject that write. So the only
genuinely dead value is `entity.delete`.

Trimming a *single* dead value (`entity.delete`) from the `op` CHECK + the
`AuditOp` union is valid but marginal on its own — not worth a standalone
forward migration. Fold it into the full Proposal A work (which reworks this
write path anyway), or skip it. Always re-grep for writers
(`grep -rn "entity.delete\|edge.add" packages` AND check `op =` assignments in
`capture.server.ts`) before changing the CHECK — the first pass here missed
that `edge.add` is emitted.

### Payoff

One write per mutation instead of two; one history vocabulary; the stale
`op` values gone. The *full* job removes a whole subsystem's write path,
but the work is "build the aggregate queries + re-point the feeds," not
"drop a table."

---

## Proposal B — Collapse the per-type node tables into one `nodes` table

**Status: ✅ DONE (shipped to production).** Implemented in four PRs:
- **#659 Stage 1a** — add the unified `nodes` table + copy migration `064`
  (additive; no behavior change).
- **#660 Stage 1b** — read + write cutover (`upsertEntity` → `nodes` with the
  data-driven `NODE_PROMOTED_COLUMNS`; ~24 web read sites; re-sync migration
  `065`). Principal folded in.
- **#661 Stage 2** — drop the 10 legacy per-type tables (migration `066`);
  registries point at `nodes`.
- **#662** — follow-up fix: consumers that read `spec.table` as a *public
  plural name* (collapsed to "nodes" once `table` became uniform) now derive
  it from `entityType`. Caught by the post-deploy production smoke.

End state: one `nodes` table discriminated by `node_type` (like `edges`);
policies kept their own tables; no renaming. "Add a node type" is now a
one-row `NODE_PROMOTED_COLUMNS` change. `node_versions` remained the backup
net throughout. The spec below is retained as the record of how it was done.

---

### Original spec

Decisions locked with the project owner (this thread):

- **Do it.** The per-type sharding is a false split; `edges` already proves
  the single-table-with-discriminator pattern works in this codebase.
- **Policies are NOT nodes.** `guidance_policies` / `node_authoring_policies`
  stay their own tables. They share the `node_versions` spine (so the rebuild
  must filter `entity_type`), but they are governance config, not graph
  knowledge, and the index layer already partitions them
  (`entity_fts_nodes` vs `entity_fts_policies`).
- **No renaming.** Vocabulary stays `node` / `edge`.

### The problem

The schema has **10 node tables** (`intents`, `decisions`, `rules`,
`actions`, `logs`, `evals`, `reference_entities`, `states`, `ideas`,
`principals`), all near-identical:
`id, doco_id, lifecycle, <type-named prose column>, <promoted scalars/FKs>,
data jsonb, created_at/by, updated_at/by`. The sharding cost is spread across
the codebase (inventory taken this thread):

- **`packages/db/src/repo.ts`** — `upsertEntity()` routes via
  `ALL_ENTITY_TABLES[type].table` and bridges "one jsonb bag" ↔ "per-type
  physical columns" with three per-type machines: `fkColumnSources()` (a
  `switch`), `PROMOTED_DATA_KEYS_BY_TYPE`, and `stripPromotedKeys`. Principals
  take a *separate* writer (`upsertIdentity`).
- **`packages/db/src/types.ts`** — `NODE_TABLES`, `DOCO_NODE_TABLE_SPECS`,
  `DOCO_NODE_TABLE_BY_TYPE`, `ALL_ENTITY_TABLES`: parallel registries whose
  node entries exist *only* to map type → table.
- **Read paths — 23 files.** The big ones build `UNION ALL` over the per-type
  tables, mostly driven by the registries: `full-graph.server.ts`
  (`overviewRowsSql`, `overviewRowsSqlMulti`), `approval-perspective.server.ts`
  (`approvalRowsSql`, 10-leg), `node-detail.server.ts` (`relatedDetailsSql`),
  `bpmn-perspective.server.ts`, `doco-stats.server.ts`, `slack.server.ts`,
  plus hard-coded UNIONs in `routes/$docoHandle._index.tsx`, `orgs*.tsx`,
  `dashboard.tsx`, the `edges` routes, and single-table reads in
  `glossary-perspective`, `sla-perspective`, `repo.ts` (`getPrincipalById`,
  `listPrincipals`), `search.server.ts`.
- **`schema.sql`** — 10 near-identical `CREATE TABLE` + index blocks.

`EntityRecord` (in `types.ts`) is **already** the single-table shape. The
per-type tables are an implementation detail under an abstraction that is
already uniform.

### Target schema (the "wide nodes" design)

The table keeps **every promoted column as a real column** — *preserving
column names* — so the ~23 read sites change only their `FROM` clause
(`FROM <type> t` → `FROM nodes t WHERE node_type = '<type>'`), not their
SELECT lists. Intra-node FKs are **dropped** (app-enforced, exactly like
`edges`); this is safe because **every inbound FK to a node table comes from
another node table** — verified, zero external references — so dropping the
per-type tables breaks no outside constraint. Narrowing the wide table
(scalars → jsonb + expression indexes) is a *later, optional* pass; the merge
itself stays a pure structural move.

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id             text PRIMARY KEY,            -- <type>_<ulid>
  doco_id        text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  node_type      text NOT NULL,              -- intent|idea|rule|decision|action|log|eval|reference|state|principal
  lifecycle      text,
  prose          text NOT NULL DEFAULT '',   -- unified type-named column (the 9); '' for principals
  name           text,                       -- principal label (NULL otherwise)
  body_md        text,                       -- principal description (NULL otherwise)
  role_principal boolean NOT NULL DEFAULT false,
  -- promoted relationship columns (no FK; existence app-enforced, like edges)
  parent_intent_id          text,            -- intent
  proposer_id               text,            -- idea
  decided_by                text,            -- decision
  superseded_by_decision_id text,            -- decision
  actor_id                  text,            -- action, log
  template_id               text,            -- log
  -- promoted scalar columns
  verb         text,                          -- action, log
  performed_at text,                          -- action
  happened_at  text,                          -- log
  kind         text,                          -- eval, rule, state
  modality     text, severity text, phase text, on_violation text,  -- rule
  ref_type     text, locator text, citation text, title text,        -- reference
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX IF NOT EXISTS nodes_doco_type_idx ON nodes (doco_id, node_type, created_at DESC);
CREATE INDEX IF NOT EXISTS nodes_doco_life_idx ON nodes (doco_id, lifecycle);
CREATE INDEX IF NOT EXISTS nodes_superseded_idx ON nodes (superseded_by_decision_id) WHERE superseded_by_decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS nodes_actor_idx ON nodes (actor_id) WHERE actor_id IS NOT NULL;
```

Per-type column map (source table column → `nodes` column), used by both the
data-copy migration and the data-driven writer:

| node_type | prose source | promoted columns (col ← data field) |
|---|---|---|
| intent | `intents.intent` | `parent_intent_id` |
| idea | `ideas.idea` | `proposer_id` |
| rule | `rules.rule` | `kind, modality, severity, phase, on_violation` |
| decision | `decisions.decision` | `decided_by`, `superseded_by_decision_id` ← `superseded_by` (only when `decision_`-prefixed) |
| action | `actions.action` | `actor_id, verb, performed_at` |
| log | `logs.log` | `actor_id, template_id, verb, happened_at` |
| eval | `evals.eval` | `kind` |
| state | `states.state` | `kind` |
| reference | `reference_entities.reference` | `ref_type, locator, citation, title` |
| principal | — (`prose=''`) | `name, body_md, role_principal` |

### Migration mechanics

`ensureSchema()` runs `schema.sql` → numbered migrations → `schema.sql` again
(idempotent bookend) on first DB access per container; each migration is
transactional and recorded in `applied_migrations`. Production has live
post-genesis-reset data, so the migration **copies real rows** (a direct
`UNION ALL` from the 10 tables — *not* a `node_versions` rebuild, since the
per-type tables are the live store written directly by `upsertEntity`).

### Staging — each stage its own tested PR, landed on `main`

**Stage 0 — data-driven node-column spec (no schema change).** Replace the
`fkColumnSources` switch + `PROMOTED_DATA_KEYS_BY_TYPE` + the
`NODE_TABLES`/`DOCO_NODE_TABLE_SPECS` node entries with one
`NODE_COLUMN_SPECS` table (the map above). `upsertEntity` and the registries
derive from it. Pure refactor; behavior-identical; shrinks `repo.ts`. Tested
by `schema-consistency.test.ts` + db smoke. *De-risks Stage 1 and is the
foundation for the writer.*

**Stage 1 — introduce `nodes`, cut over writes + reads, copy data, keep the
old tables.** Add `nodes` to `schema.sql`; add migration
`064_collapse_node_tables.sql` that `INSERT … SELECT`s the 10 tables into
`nodes` (`ON CONFLICT (id) DO NOTHING` for idempotency) but **does not drop**
them. Route `upsertEntity` (incl. principals — fold `upsertIdentity`'s
principal branch in) and all node reads at `nodes`. The old per-type tables
remain as a stale rollback safety net (deeper net: `node_versions`). Verify
exhaustively on local Postgres **and** production before Stage 2.

**Stage 2 — drop the per-type tables.** Once Stage 1 is production-verified:
remove the 10 `CREATE TABLE`s from `schema.sql` and add migration
`065_drop_legacy_node_tables.sql` (`DROP TABLE … CASCADE`). Removing them from
`schema.sql` is required so the bookend's second pass doesn't recreate them.

### Risk & verification

- **Blast radius** is the ~23 read files + the write path; the wide design
  keeps each read edit mechanical (FROM-clause only).
- **Data safety:** Stage 1 copies (doesn't move) and retains the originals;
  `node_versions` is an independent backup.
- **Verify:** `pnpm -r typecheck/test`, `biome`, real `@doco/web` build; db
  integration against local Postgres (`vnext-smoke`, `vnext-verify-test`, plus
  a new `nodes`-collapse test asserting row-count + field parity per type
  before/after the copy); then production smoke via the dev-signin recipe
  (create a Doco, capture one of each node type, read it back through every
  migrated perspective).

### Payoff

Removes 10 table definitions, the three per-type write machines in `repo.ts`,
the type→table registries, and every `UNION ALL`-over-node-tables read —
making "add a node type" a data change (one `NODE_COLUMN_SPECS` row) rather
than a schema + registry + SQL change.

---

## Smaller follow-ups noted during the review (not yet done)

- **Edge capture bypasses the authoring-policy gate** that node capture runs
  (`enforceAndPersist`). If edges should be policy-gated, route
  `captureEdge` through the same enforcement. Behavior change — confirm
  intent first.
- **Dead provenance fallbacks**: the `data->>'owner_id'` /
  `data->>'created_by'` COALESCE branches in `node-detail.server.ts` and
  `approval-perspective.server.ts` can never match post-genesis-reset
  (those became columns before the wipe). Safe to delete, but the payoff is
  cosmetic and it isn't DB-testable without seeding the old shape, so it was
  left. Fold into Proposal B's read-path pass.
