# Doco v-next — first-class edges + append-only history

**Status:** Plan, decisions locked 2026-05-30. Not yet implemented.
**Owner:** Alex (project owner).
**Scope:** Architecture change + neuron→node / synapse→edge rename + clean data reset.

---

## Goals

1. **Edges become first-class.** An edge (today: "synapse") gets its own identity,
   lifecycle, permissions, provenance, and history — a peer of a node, not a derived
   cache.
2. **Rename** `neuron → node` and `synapse → edge` everywhere. **No backwards
   compatibility.**
3. **Nothing is ever deleted.** Things change; the full prior history is always
   recoverable, and a consumer (person or agent) can see the current state and then
   *very quickly* see how it was before and **why it changed**.

## Non-goals (v1)

- Pure event-sourcing with replay-derived projections (see **D13** — we chose the
  snapshot model deliberately).
- A native graph database (Postgres stays; see "Why Postgres" below).
- Bitemporal *valid-time* axis — v1 is transaction-time only ("when Doco learned it").
- Cryptographic Merkle chaining — columns reserved, compute deferred (Track M).

## Why Postgres (not a graph DB)

The workload is tenant-scoped, shallow-traversal (1-hop neighbors, bounded
subgraphs), and PageRank already runs in-app. A property-graph DB would *not* give
us edge lifecycle, per-edge-type permissions, immutable versioned history, multi-
tenancy, or vector/FTS for free — we'd reimplement them on an engine that is worse at
exactly the temporal + tenancy + search properties we depend on. If deep traversal
ever appears: recursive CTEs or Apache AGE (openCypher *inside* Postgres). The
append-only history requirement *reinforces* this — it is natural in relational and
awkward in a graph DB.

---

## Locked decisions

| # | Decision | Locked value |
|---|----------|--------------|
| D1 | Edge storage | **One `edges` table** keyed by `edge_type` (not per-type tables). |
| D2 | Node relation arrays (`implemented_by`, `intent_ids`, …) | **Kept as inline authoring sugar** on create, but the **edge row is canonical**. Reads come from `edges`, not frontmatter. |
| D3 | Edge lifecycle | **drafting / asserted / retired**, default `asserted`. |
| D4 | Edge history + audit | **Mandatory** `edge_versions` + commit-log entries. |
| D5 | Edge mutability | Endpoints (`from_id`, `to_id`, `edge_type`) **immutable**; `props` + `lifecycle` mutable. To "move" an edge: retire + create. |
| D6 | Duplicate prevention | `UNIQUE(doco_id, from_id, to_id, edge_type) WHERE lifecycle <> 'retired'`. |
| D7 | Provenance-as-edges | **Dropped.** `created_by`/`updated_by` are columns, not edge types (avoids regress). |
| D8 | Node retire ↔ edges | Retiring a node **leaves its edges**; graph reads hide edges touching a retired node by default. Hard delete cascades (reset only). |
| D9 | Rename scope | **Full**, incl. public API field names, capture specs, and agent-protocol strings ("N **nodes** found", glossary). This is a protocol-version event. |
| D10 | Commit granularity | A **commit = one changeset** (atomic intent); per-entity version rows underneath. |
| D11 | Time-travel | Store `tx_id` on every version **from day one**; expose as-of *reads* incrementally (Phase 4). |
| D12 | Merkle chaining | Columns `prev_hash`/`this_hash` **reserved now**, compute **deferred** (Track M). |
| **D13** | **Source of truth** | **(B) state-authoritative + version shadow, with a rich commit log.** Current-state tables are authoritative for reads; every write *also* appends an immutable full snapshot + a commit-log entry, in one transaction. Snapshots make "how it was before" an O(1) read; the rich commit log carries the "why". |

### Why (B) + rich commit log (the spine rationale)

- The hot path is **fast random-access historical reads**. (B) stores **full
  snapshots**, so "how did this look at vN / as-of T" is a single indexed `SELECT`
  with zero compute. (A) would have to bolt snapshots onto an event log to match.
- **Git itself is snapshots, not deltas** — (B) is the faithful Git object model.
- "Why it changed" = snapshot **diff** (what) + **commit log** (who/when/why), both
  cheap. The rich commit log is what makes the "why" answerable.
- (B) is where Doco already lives (`neuron_versions`, `lifecycle=retired`), so it is
  the low-risk path and it does not foreclose (A) later (we keep both the full commit
  log and full snapshots).

---

## Architecture: the spine

Three layers, Git's object model:

```
  COMMIT LOG       changesets               immutable, append-only, monotonic tx_id   = git commit
   (who/when/WHY)        │ produces
                         ▼
  VERSION ROWS     node_versions            immutable, write-once, FULL snapshot/vN   = git blob/tree
   (how it was)    edge_versions                  │ projects                          ← "how it used to be"
                         ▼
  CURRENT STATE    per-type node tables      MUTABLE cache, rebuildable, indexed       = git working tree
   (HEAD)          + edges                                                            ← fast reads / PageRank / FTS
```

**The `commit()` boundary (the enforcement point).** Every write — API, MCP, UI,
Slack, import — funnels through one transaction wrapper that, atomically:

1. allocates a `tx_id` and writes a **commit-log row** (actor, source, **reason/why**, recorded_at);
2. appends an immutable **version snapshot** for each touched node/edge (`op` = create|update|retire);
3. updates the **current-state projection** (per-type node tables / `edges`).

It **never** issues `DELETE` or destructive `UPDATE` on the history layers. "Delete"
is an `op=retire` version with `lifecycle=retired`.

---

## Target data model (Postgres)

```sql
-- COMMIT LOG (promote/extend existing changesets + audit_log; never pruned)
CREATE TABLE changesets (
  tx_id        bigserial PRIMARY KEY,        -- global monotonic ordering for as-of
  doco_id      text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  actor        text NOT NULL,                -- user_/agent_ id
  source       text NOT NULL,                -- api | mcp | ui | slack | import | reset
  reason       text,                         -- the rich "why" (free text; agents/UI supply it)
  metadata     jsonb,                        -- client, ip, request id, etc.
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

-- VERSION ROWS (generalize neuron_versions → node_versions; add edge_versions — same shape)
CREATE TABLE node_versions (
  entity_id    text NOT NULL,
  version      int  NOT NULL,                -- 1,2,3…
  op           text NOT NULL,                -- create | update | retire
  payload      jsonb NOT NULL,               -- FULL snapshot of the entity at this version
  tx_id        bigint NOT NULL REFERENCES changesets(tx_id),
  actor        text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,                         -- Track M (reserved)
  this_hash    text,                         -- Track M (reserved)
  PRIMARY KEY (entity_id, version)
);
CREATE INDEX node_versions_asof ON node_versions (entity_id, tx_id);
-- edge_versions: identical shape + indexes.

-- CURRENT STATE — first-class edges (replaces derived `synapses`)
CREATE TABLE edges (
  id           text PRIMARY KEY,             -- edge_<ULID>
  doco_id      text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  edge_type    text NOT NULL,
  from_id      text NOT NULL,                -- app-validated; no FK (endpoints span node tables)
  from_type    text NOT NULL,
  to_id        text NOT NULL,
  to_type      text NOT NULL,
  props        jsonb,
  lifecycle    text NOT NULL DEFAULT 'asserted',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  retired_at   timestamptz
);
CREATE UNIQUE INDEX edges_live_uniq ON edges (doco_id, from_id, to_id, edge_type)
  WHERE lifecycle <> 'retired';
CREATE INDEX edges_doco_type_from ON edges (doco_id, edge_type, from_id);
CREATE INDEX edges_doco_type_to   ON edges (doco_id, edge_type, to_id);
CREATE INDEX edges_lifecycle      ON edges (doco_id, lifecycle);

-- Current-state nodes = the existing 10 per-type tables (now formally the projection).
-- Grants tables UNCHANGED: write_types / granted_*_write_types already hold arbitrary type strings.
```

---

## Invariants (the immutability laws)

1. **All writes go through `commit()`.** No direct table mutation outside it.
2. **History is append-only.** No `DELETE`, no `TRUNCATE`, no destructive `UPDATE` on
   `changesets`, `node_versions`, `edge_versions`. "Delete" = `op=retire`.
3. **DB-role guardrails.** The app role gets `INSERT`/`SELECT` only on the history
   tables (no `UPDATE`/`DELETE`); `UPDATE`/`DELETE` allowed only on the rebuildable
   projection.
4. **Projection is rebuildable** from latest snapshots (disaster recovery).
5. **`tx_id` is monotonic** and shared by node + edge versions → whole-graph as-of.
6. **The genesis reset is the one permitted destructive act.** After it, append-only
   is law (recorded as a `source=reset` changeset).

---

## Build order

Each phase compiles/ships independently; risk is isolated to Phase 2–3.

### Phase 1 — Shared vocabulary + kind-agnostic core  (`packages/shared`)
- `branded.ts`: `NEURON_TYPES → NODE_TYPES`, `NeuronType → NodeType`; `SYNAPSE_TYPES →
  EDGE_TYPES`, `SynapseType → EdgeType`; entity-id helper unchanged (ids already use the
  specific type prefix, e.g. `decision_…`).
- `ids.ts`: `synapseId() → edgeId()` (prefix `edge_`).
- `access-types.ts`: add `EDGE_TYPES` to `WRITE_GRANTABLE_TYPES`; update `WriteScope`
  comment.
- `access.ts`: `canWriteType(ctx, type)` already generic — no logic change.
- `lifecycle.ts`: ensure states are entity-kind-agnostic (shared by node + edge).
- **New:** shared types for `VersionRow`, `Commit`, and the `op` enum (used by both kinds).
- **Exit:** `pnpm --filter @doco/shared typecheck` green; nothing else built yet.

### Phase 2 — Append-only substrate  (`packages/db`) — *the spine*
- `schema.sql`: add `edges`, `edge_versions`; rename `neuron_versions → node_versions`;
  add `changesets` (rich commit log) with `tx_id`/`reason`; reserve Merkle columns.
- `migrations/063_edges_first_class_and_history.sql`: **genesis reset** — drop
  `synapses` + node relation columns, create new tables, add `tx_id`, add DB-role
  guardrails (`REVOKE UPDATE, DELETE` on history tables).
- `repo.ts`: introduce `commit()` transaction wrapper (allocate tx_id → append version
  rows → update projection → write commit row). Retire = append. Remove any
  delete/destructive-update code paths.
- `indexer.ts`: **stop owning edges** — `rebuildDocoDerivedData` no longer
  DELETE+INSERTs `synapses`; it only reads edges for PageRank/FTS. *(Highest-risk
  change — this is the one place Doco currently destroys data.)*
- **Exit:** migration runs on a scratch DB; `commit()` round-trips a node create→update→
  retire with three version rows + one commit each; history tables reject DELETE.

### Phase 3 — Edge domain & API  (`packages/web/app`)
- `lib/capture.server.ts`: edge create / update(props,lifecycle) / retire via `commit()`;
  inline edge sugar on node create now produces real edge rows.
- `lib/graph-authoring-contract.server.ts`: `RELATION_KINDS` → edge-type registry
  (direction, allowed endpoint types, cardinality, props).
- `routes/$docoHandle.api.changesets[.]json.tsx`: accept `create_edge` / `retire_edge`
  ops and a `reason` field (the "why").
- `routes/$docoHandle.api.$type[.]txt.tsx` + new edge capture specs: document edge CRUD.
- `lib/api-capture-factory.server.ts` + `lib/authenticated-creator.server.ts`: route all
  writes through `commit()`; gate edges via `canWriteType(ctx, edgeType)`; stamp
  provenance.
- **Exit:** create/retire an edge by id via API; reindex a node and confirm authored
  edges survive (regression guard for the Phase 2 indexer change).

### Phase 4 — Time-travel reads + graph read paths
- Read APIs (nodes + edges):
  - `GET …/<id>/versions` — timeline.
  - `GET …/<id>?as_of=<tx_id|timestamp>` — entity as-of.
  - `GET …/<id>/diff?from=&to=` — snapshot diff.
  - `GET …/graph?as_of=…` — whole-graph as-of.
  - `GET …/history` — commit-log feed (the "why" stream).
- Update graph reads (`pagerank`, `full-graph.server.ts`, `bpmn-perspective.server.ts`,
  `search.server.ts`, `neuron-detail.server.ts → node-detail`) to read `edges` with
  `lifecycle='asserted'` and hide edges touching retired nodes (D8).
- Rename routes `$docoHandle.synapses.* → $docoHandle.edges.*`.
- **Exit:** as-of query reconstructs a known prior state; diff matches.

### Phase 5 — UI
- `components/neuron-detail-drawer.tsx → node-detail-drawer`; new **edge detail view**
  (lifecycle, provenance, retire, version history).
- A **History** affordance on node/edge detail: timeline with who/when/**why** + diffs;
  "view as-of" toggle.
- `components/entity-graph.tsx`, `neuron-type-icon.tsx → node-type-icon`, all
  user-facing "neuron/synapse" → node/edge.
- **Exit:** click a node → see current → one click to previous version + reason.

### Phase 6 — MCP / CLI / bootstrap / docs  (dual-sync: templates **and** installed copies)
- `.agents/doco-mcp-server.mjs`, `.agents/doco-agent-client.mjs`: result strings + tool
  descriptions (node/edge); expose "query as-of" capability.
- `AGENTS.md` protocol: "N **nodes** found", glossary, indicators; `canonical-instructions`,
  `agent-oauth-recipe`.
- **Must update both** `packages/cli/templates/agent-bootstrap/` **and** the repo-root
  installed copies (`AGENTS.md`, `.claude/*.sh`, `.agents/*.mjs`, `.mcp.json`).
- **Exit:** a fresh `doco install-agent-bootstrap` emits node/edge vocabulary.

### Phase 7 — Genesis reset & cutover
- Run migration 063 against live (wipes data = the genesis commit, `source=reset`),
  redeploy, re-seed templates, verify on `https://doco.to` with a dev-signin session.

### Phase 8 — Tests & invariants
- Edge CRUD, rename, graph reads, as-of correctness, diff.
- **Invariant tests:** every change appends a version; no code path deletes history; the
  app DB role cannot delete/​update history; `commit()` is the sole write boundary.

### Track M (optional, off the critical path) — Merkle chaining
- Compute `this_hash = H(prev_hash, payload)` per version; add a verification endpoint.
- Turns "append-only by policy" into "append-only, tamper-evident." Columns already
  reserved in Phase 2.

---

## Open items to confirm during implementation

1. Exact enumeration of `neuron`/`synapse` occurrences per file (grep sweep at Phase 1).
2. Where the protocol/doc pages (`canonical-instructions`, `glossary`,
   `agent-oauth-recipe`) are served from — confirm package/route before Phase 6.
3. Inventory of every write path that must funnel through `commit()` (per-type POST/PATCH
   routes, changesets, Slack capture, importers) so none bypass the log.
4. Whether the UI graph gets a time-slider in v1 or later (Phase 5 vs. follow-up).
