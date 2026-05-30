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

Also stale today: the `audit_events` `op` CHECK still allows
`entity.delete` (nothing hard-deletes post-vnext) and `edge.add` (edges are
first-class now, not an event on a node). See "Safe slice" below.

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

Drop the dead values from the `audit_events` `op` CHECK and the `AuditOp`
union: **`entity.delete`** (no hard deletes post-vnext) and **`edge.add`**
(edges are first-class; their history is `edge_versions`, not an audit
event). Grep first to confirm nothing still writes them
(`grep -rn "entity.delete\|edge.add" packages`), then tighten the union in
`lib/audit-log.server.ts` and the CHECK in a forward migration. No
read-surface change. This is the only part of Proposal A that is
behavior-preserving.

### Payoff

One write per mutation instead of two; one history vocabulary; the stale
`op` values gone. The *full* job removes a whole subsystem's write path,
but the work is "build the aggregate queries + re-point the feeds," not
"drop a table."

---

## Proposal B (north-star) — Collapse the per-type node tables into one `nodes` table

### The problem

The schema has **10 node tables** (`intents`, `decisions`, `rules`,
`actions`, `logs`, `evals`, `reference_entities`, `states`, `ideas`,
`principals`) + **2 policy tables**, all near-identical:
`id, doco_id, lifecycle, <type-named prose column>, <promoted scalars>,
data jsonb, created_at/by, updated_at/by`. Post-vnext these tables are
**explicitly a rebuildable projection** of `node_versions` (see
`schema.sql`: "the per-type node tables and `edges` are a rebuildable
projection") — i.e. they are a cache, and the cache is sharded by type for
no load-bearing reason.

The cost of that sharding is spread across the codebase:

- **`packages/db/src/repo.ts`** — `upsertEntity()` is already table-driven
  via `ALL_ENTITY_TABLES[type].table`, but bridges "one jsonb bag" ↔ "per-type
  physical columns" with three per-type machines: `fkColumnSources()` (a
  `switch` over 8 types), `PROMOTED_DATA_KEYS_BY_TYPE`, and
  `PROMOTED_COLUMNS_BY_TYPE`.
- **`packages/db/src/types.ts`** — `NODE_TABLES`, `DOCO_NODE_TABLE_SPECS`,
  `ALL_ENTITY_TABLES`: parallel registries that exist *only* to map type →
  table.
- **Read paths** — `full-graph.server.ts`, `approval-perspective.server.ts`,
  `search.server.ts`, etc. build `UNION ALL` over the per-type tables
  (`approvalRowsSql()` is a 9-leg UNION).
- **`schema.sql`** — ~10 near-identical `CREATE TABLE` + index blocks, plus
  the matching FTS plumbing.

`EntityRecord` (in `types.ts`) is **already** the single-table shape:
`{ id, doco_id, entity_type, data, body_md?, lifecycle?, … }`. The storage
layer round-trips everything through it. The per-type tables are an
implementation detail underneath an abstraction that is already uniform.

### Target design

One table:

```sql
CREATE TABLE nodes (
  id           text PRIMARY KEY,            -- <type>_<ulid> (prefix = type)
  doco_id      text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  node_type    text NOT NULL,              -- decision | intent | …
  lifecycle    text,
  prose        text NOT NULL DEFAULT '',   -- the type-named column, unified
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX nodes_doco_type    ON nodes (doco_id, node_type, created_at DESC);
CREATE INDEX nodes_doco_life     ON nodes (doco_id, lifecycle);
```

This erases: the 10 `CREATE TABLE`s, the type→table registries, the per-type
`UNION ALL` reads (now `WHERE node_type = ANY(...)`), and most of
`upsertEntity`'s dispatch. `node_versions` already carries `entity_type`, so
the projection rebuild is `INSERT INTO nodes SELECT … FROM (latest snapshot
per entity)`.

### The real trade-off (why it is a north-star, not a now)

The per-type **promoted columns** are not pure duplication — they buy two
things a single jsonb table loses:

1. **Typed foreign keys.** `actions.actor_id → principals(id)`,
   `decisions.superseded_by_decision_id → decisions(id)`,
   `intents.parent_intent_id → intents(id)`, `logs.template_id → actions(id)`,
   `ideas.proposer_id → users(id)`. A single table can't FK a column to ten
   different target tables. Options: drop the FKs (rely on app-level
   validation, exactly as `edges` already does for its endpoints — see
   schema.sql "no FK; existence enforced in app code"), or keep a thin
   side-table of typed references. The `edges`-style precedent argues this is
   acceptable.
2. **Filter/sort indexes on promoted scalars** — `rules.severity`,
   `actions.performed_at`, `logs.happened_at`, `reference_entities.ref_type`.
   In one table these become either expression indexes on `data->>'…'` or a
   handful of generated columns. Postgres supports both; needs measurement.

Other considerations: the FTS tables (`entity_fts_nodes` already unifies the
node category — good), `principals` carries `name` + `body_md` + the
`role_principal` promoted boolean (slightly different shape — fold its prose
into `prose`, keep `role_principal` in `data` or as a generated column), and
this is a **schema migration with a projection rebuild** — low data-loss risk
because the source of truth is `node_versions`, but it touches every read
path, so it wants its own milestone.

### Suggested staging (each independently shippable)

1. **Collapse the registries first** (no schema change): make
   `fkColumnSources` / `PROMOTED_*` data-driven from one per-type spec
   instead of `switch`/hand-maintained sets. Pure refactor; shrinks repo.ts.
2. **Introduce `nodes`** alongside the per-type tables; have the projection
   write both; move reads over table-by-table behind the existing
   `EntityRecord` API.
3. **Drop the per-type tables** once all reads are off them; rebuild the
   `nodes` projection from `node_versions` to prove the projection is
   authoritative.

### Payoff

Removes ~10 table definitions, three per-type machines in `repo.ts`, the
type→table registries, and every `UNION ALL`-over-node-tables read — while
making "add a node type" a data change (one spec entry) rather than a schema
+ registry + SQL change. The append-only spine already guarantees the
per-type tables are reconstructable, so the safety argument is unusually
strong for a change this size.

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
