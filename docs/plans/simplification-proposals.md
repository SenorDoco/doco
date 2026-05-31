# Open simplification proposal: collapse the two history systems

**Status:** Proposal (not scheduled). Written 2026-05-30, trimmed 2026-05-31.
**Context:** A re-review of the codebase for "is Doco as simple and abstract
as it can be?" after the doco-vnext migration (first-class edges +
append-only history). The behavior-preserving cleanups from that review have
shipped; the collapse below is **behavior-affecting** and is kept here for a
deliberate, separately-reviewed PR rather than folded into a cleanup change.

> Already shipped from this review (removed from this doc): the per-type node
> tables were collapsed into one `nodes` table (PRs #659–#662); the dead
> `entity.delete` audit op was removed (#665 / migration `067`); and the dead
> `data->>'owner_id'` / `data->>'created_by'` provenance fallbacks were
> deleted. What remains open is the `audit_events` ↔ commit-log overlap below.

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

### Payoff

One write per mutation instead of two; one history vocabulary. The job
removes a whole subsystem's write path, but the work is "build the aggregate
queries + re-point the feeds," not "drop a table."

---

## Open follow-up noted during the review (not yet done)

- **Edge capture bypasses the authoring-policy gate** that node capture runs
  (`enforceAndPersist`). If edges should be policy-gated, route
  `captureEdge` through the same enforcement. Behavior change — confirm
  intent first.
