# Simplification plan: one canonical shape per entity

> **Status: ACTIVE — in progress.** This is an execution plan, not a proposal.
> It is the source of truth for the entity-shape normalization. Update it as
> slices land. The guiding principle behind it lives in `AGENTS.md` →
> "Simplify relentlessly."

## Why this exists

The system represents persisted data in more shapes than it has tables. A node's
text exists under four different names depending on the layer you're in
(`prose` the column, `type_named_value` on the record, the type-named key
`intent`/`decision`/… in the candidate bag, `name` for principals). On read we
rebuild a *fake copy of a dropped `data` jsonb column* (`rowToRecord`) instead of
exposing the real columns. The "open-ended tail" is called three different
things across tables (`attributes` on nodes, `props` on edges, `data` on
users/workspaces/docos/host). Every entity has a bespoke mapper that renames or
reconstructs on read, and a single `EntityRecord` god-type tries to cover them
all with optional `data`/`name`/`summary`/`type_named_value`/`body_md`.

This complexity is what every future human and agent has to hold in their head,
and it is the direct cause of a live bug (below).

### The live bug this fixes

On the **re-evaluation / update path**, a stored node is loaded via
`readEntityFromPostgres` → `getEntity` → `rowToRecord`. `rowToRecord` rebuilds a
`data` bag from the system columns + `attributes` but routes the node's `prose`
into a *separate* property (`type_named_value`), never back into the bag. The
loader then forwards only `data` to the authoring-policy judge — so the judge
receives a candidate with **no prose under any key** and reports "the candidate
lacks a `prose` field entirely," regardless of what the author actually wrote
and regardless of the field name the policy spec uses. Initial capture works
(it builds the bag with the text in it); only re-grading a stored node fails.
Slice 1 removes the reconstruction, so the bug cannot exist.

## The principle

**Every persisted thing is one table, one in-memory type that mirrors it 1:1,
one name per field.**

1. Fields you filter/join/index/constrain on are **typed columns**.
2. The node text is always **`prose`**, for every node type. No type-named keys,
   no `type_named_value`, no `computeTypeNamedValue`.
3. The only open-ended bag is **`extra`**, and it exists **only on nodes** — it
   is user space, **empty by default**, never written to by the system.
4. The row→object mapper is a dumb pass-through (parse jsonb, ISO-format
   timestamps), **identical for every table**. One generic `rowToEntity`, one
   honest type per entity. No `EntityRecord` god-type.
5. Read shape ≡ write shape ≡ API shape ≡ capture-input shape.
6. No backward-compat shims. One name per concept, documented once.

Config/identity entities (doco, workspace, user, host, token, edge) get **no
bag at all** — anything they need is a named column or a normalized table, added
when there is a concrete need (YAGNI), never speculatively. The presence of
`extra` then *means something*: "this is extensible user content."

## Field decisions (locked)

**Survives as a typed column:**
- `nodes.locator` (the one node domain field we keep — reference dedup key,
  already indexed)
- `nodes.kind` (already a column — eval/state/principal classifier)
- `nodes.prose`, plus identity/audit/lifecycle universals
- `docos.goal` (already a column; fix the stale `data->>'goal'` read in
  `slack.server.ts` to use it)

**Dropped for good:**
- nodes: `ref_type`, `citation`, `body_md`, `body`, `severity`, `verb`,
  `happened_at`, `title`, `performed_at`, `phase`, `on_violation`
- edges: `role` and the entire `props` column
- workspaces / host: the `data` bag

**Kept as is (decided 2026-06-05 — real load-bearing config, not cruft):**
- docos `data` — `github_integration` + `template_handle`
- users `data` — `preferences` + `name`/`display_name`

## Target schemas (as landed)

```
Node      = { id, doco_id, node_type, lifecycle, prose, kind?, locator?,
              extra, created_at, created_by, updated_at, updated_by }
Edge      = { id, doco_id, edge_type, from_id, from_node_type, to_id,
              to_node_type, lifecycle, label?, condition?, kind?, …audit }
Workspace = { id, handle, name, constitution, …audit }       // bag dropped
Host      = { id, name, visibility, …audit }                 // bag dropped
Doco      = { …columns, goal, data }   // data kept: github_integration, template_handle
User      = { …columns, data }         // data kept: preferences, name, display_name
Principal = Node where node_type = 'principal'
```

## Consequences absorbed as part of the work

- **`ref_type` / `citation` gone** → glossary & SLA perspectives drop those
  fields.
- **`body_md` / `body` gone** → org-tree & node-detail stop rendering a body;
  authors who want one put it in `extra`.
- **`severity` gone** → remove any severity-based rendering.
- **Policy specs** migrate from the type-named word (`intent`/…) to `prose`.

## The one sanctioned exception (does NOT soften the principle)

The principle above stands exactly as written. A node's only bag is the
author-owned **`extra`** — empty by default, never written to by the system —
and config/identity entities carry no bag at all. There is exactly ONE
carve-out: **`docos.data` and `users.data` stay as jsonb**, by deliberate,
owner-approved decision (2026-06-05), because they hold genuinely load-bearing
nested config (`github_integration` / `template_handle` on docos; `preferences`
/ `name` / `display_name` on users) whose re-homing is large, risky, and
low-payoff while the jsonb is doing its job. That is a *named exception for two
tables*, not a general relaxation to "no *cruft* bags": every node is still held
to one shape, one name per field, and no system-written bag.

## Execution — staged, test-first, each its own PR squash-merged to `main`

For every slice: (1) write a failing **PGlite real-DB** test capturing the
intended shape/behavior and watch it go red; (2) make it green; (3) land on
`main` via feature branch → PR → CI green → auto-merge squash; (4) verify live
on `doco.to` (dev-signin recipe in `AGENTS.md`) with a screenshot.

1. **Nodes — DONE (#1068 + the node-bag normalization #1081/#1084/#1086/#1088).**
   Read `prose` directly, deleted `type_named_value` / `computeTypeNamedValue` /
   the type-named keys; migrated policy specs → `prose`; **landed the live
   re-evaluation bug fix.** The node bag is now the empty, author-owned `extra`
   (renamed from `attributes`); every system field is a real typed column. The
   node-bag normalization slices below (6.A–6.D) finished it; only the optional
   mapper-teardown (6.E) remains.
2. **Edges — DONE (#1069).** Promoted the flows_to metadata to typed columns
   (`label`/`condition`/`kind`); dropped `role` and the `props` jsonb; deleted
   the `edge_props_json` alias.
3. **Workspaces + Host — DONE (#1070).** Dropped the never-read `data` bag on
   both; defined columns only.
4. **Docos — KEEP AS IS (decided 2026-06-05).** Its `data` bag holds genuinely
   load-bearing nested config: `github_integration` (a ~47-site read/write in
   `github-connection.server.ts`) and `template_handle` (runtime principal
   lifecycle, the agent create-doco contract/response, 13 template-scoped policy
   migrations). Normalizing it is large, risky, low-payoff — leave the jsonb.
5. **Users — KEEP AS IS (same reasoning).** `data` holds `preferences` (UI
   state) and `name`/`display_name` (read for display). Real config; leave it.
6. **Node-bag normalization — A–D DONE; E optional.** The node bag is now the
   empty, author-owned `extra`; every system field is a real typed column. Done
   as ordered, test-first, squash-merged slices (each with a real-DB
   upgrade-path migration test):
   - **A. Drop `body_md` — DONE (#1081).** Principals and PR references lose their
     body; a node's only text is `prose`. Org-chart vacancy reads `kind` +
     `prose`.
   - **B. Promote `locator` to its own `nodes.locator` column — DONE (#1084).**
     The reference-dedup index now reads the column, not the bag.
   - **C. Drop `ref_type` / `citation` / `severity` / `title` / `body` for good —
     DONE (#1086).** Earlier migrations had folded them into the bag instead of
     deleting them; the capture contract, the rule severity UI, and the
     SLA/glossary rendering of those fields are gone too (owner-approved full
     drop).
   - **D. Rename the node bag `attributes` → `extra` — DONE (#1088).** The
     guarded in-place column rename, once the bag held no system fields.
   - **E. Retire the `EntityRecord` god-type — DONE.** Reads already go through
     one honest mapper per node (`rowToNode` → `NodeRow`). The write side is now
     symmetric: one honest writer **per category**, no generic envelope.
     - One node→JSON serializer (`nodeToApi`) replaced the drifting parallel
       node-shape shapers (#1120).
     - One node write boundary: `nodeRowFromFields(type, fields) → NodeRow`,
       fed to `upsertNode(node)` — the symmetric counterpart of `rowToNode`
       (write path #2A).
     - The generic `EntityRecord` + `upsertEntity` dispatcher are **deleted**
       (write path #2B). Nodes write a `NodeRow` (no `data` bag); policies write
       a `PolicyWrite` (keeping their real `policies.data` jsonb); identity rows
       (user/doco/workspace) already have their own typed writers in
       `packages/host/src/host.ts`. There is no cross-category god-type.
     - **The identity-table READ mappers (`mapUserRow`/`mapWorkspaceRow`/
       `mapDocoRow`) stay** — they are genuinely distinct per-table column
       readers (e.g. `mapDocoRow` JOINs for the owner handle), not a renaming
       shim. Folding them into one mapper would inline the same logic at call
       sites, not remove it; per the principle above (typed columns + one honest
       type per entity) they are already honest. This closes slice 6.E.


## Verification regime (run after each UI-touching slice; exhaustively at the end)

Enumerate the actual list from the routes/templates in-code — do not guess.

- **Every page** — walk all routes (dashboard, doco home, node detail, edges,
  policies, activity, integrations, onboarding, settings, workspace pages,
  device/oauth). Each must return 200 and render.
- **Every perspective** — bpmn, org-tree, glossary, SLA, pull-requests,
  full-graph, doco-home — on real data, **including random exploration** (click
  into random nodes/edges/perspectives to surface anything the schema change
  broke). Screenshots as evidence.
- **API** — every `api/v1/*` and `$docoHandle.api.*` endpoint: list, read-by-id,
  capture, update, edges, policies.
- **MCP** — `doco_whoami`, `doco_search`, `doco_get`, `doco_capture`,
  `doco_relate`, `doco_changeset` against a live workspace.
- **Templates** — create a doco from **each** template (generic,
  business-processes, org-chart, glossaries, …) and **experiment with multiple
  ways of adding content** (different capture shapes, edges, lifecycle
  transitions, the authoring-policy judge path) to confirm the new
  `prose` / `extra` / column model holds end to end.

## Persistence — not optional

Do not stop because the work is long. Finish a slice, verify it, land it, then
immediately pick up the next — all the way through slice 6 and the full
verification sweep. A green CI run on one slice is **not** "done"; *done* is the
entire system migrated, every page/perspective/API/MCP/template exercised, and
the complexity actually removed. If you feel the urge to stop and report
progress mid-effort, that is the signal to keep going. Tiredness or a long road
is never a reason to leave a simplification half-applied — a half-applied change
leaves two shapes where there should be one, which is worse than where you
started.
