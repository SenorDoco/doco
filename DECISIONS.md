# Doco — Design Decisions Log

A consolidated record of every meaningful design decision made to date, intended as a hand-off to an implementing agent. Each entry: the choice made, alternatives rejected, why, and where the resulting design lives in [SCHEMA.md](SCHEMA.md) or [PLANNING.md](PLANNING.md).

> **For implementers:** these are the *settled* decisions. Open questions are listed in §13 — those are the places where the implementing agent should expect to make further calls (or come back to ask).

---

## 1. Foundation

### D-001 — Optimization priority order (strict)

- **Chosen:** AI agent comprehension > AI agent updates > Human comprehension > Scoping > Version control > Performance > Automated issue identification.
- **Why:** Drives every other tradeoff. When two design pressures conflict, the higher priority wins. Crucially, agent comprehension is above reader comprehension — when the two diverge, schema choices favor what's parseable by agents.
- **Ref:** SCHEMA.md §1.

### D-002 — Storage = git repository (one file per entity)

- **Chosen:** An Doco *is* a git repository. Each entity is a single file in a kind-named directory (`intents/`, `rules/`, ...). Source-of-truth is the file tree.
- **Alternatives rejected:** Database-backed primary store (loses git-native VC); content-addressed object store (heavier; less developer-mental-model friendly).
- **Why:** Version control, branching, diffs, and merge are free. Matches priority 5 cheaply. Supports per-clone local index without contaminating the source.
- **Ref:** SCHEMA.md §2.

### D-003 — File format = YAML frontmatter + Markdown body

- **Chosen:** Structured fields in YAML frontmatter; narrative in Markdown body. Both audiences in one file.
- **Alternatives rejected:** Pure JSON (cleaner for agents, worse for people); pure Markdown (worse for agents).
- **Why:** Agents parse YAML cleanly; people read Markdown narrative. Single-file model keeps the unit of change atomic.
- **Ref:** SCHEMA.md §2.

### D-004 — IDs = `{node_type}_{ULID}`

- **Chosen:** Every entity gets a ULID prefixed by its `node_type`. ULIDs sort by creation time, are URL-safe, and need no central coordinator.
- **Alternatives rejected:** UUIDv4 (no time order; longer); auto-increment per Doco (forces coordination on writes — bad for agent updates).
- **Why:** No coordination, time-sortable, type discoverable from ID alone (priority 1).
- **Ref:** SCHEMA.md §7.

### D-005 — Discriminator field is `node_type`

- **Chosen:** Every entity has a `node_type:` field in its frontmatter. The umbrella noun for entities is **node**.
- **Alternatives rejected:** `kind:` (unclear — "kind of what?"); `type:` (collides with `User.type`); `entity_type:` (more verbose, less aligned with "graph" framing).
- **Why:** Reads as "type of node" — unambiguous; aligns with the graph framing of Doco's data model.
- **Ref:** SCHEMA.md §3 + every §4 entity.

---

## 2. Schema shape

### D-006 — Common fields on every entity

- **Chosen:** `id`, `doco_id`, `node_type`, `summary`, `created_at`/`by`, `updated_at`/`by`, `lifecycle`, `tags`, `born_from` (optional).
- **Why:** Common fields are the API surface every consumer can rely on. `summary` serves readability (priority 3); `lifecycle` standardizes state across all stateful entities.
- **Ref:** SCHEMA.md §3.

### D-007 — Canonical lifecycle across all stateful entities

- **Chosen:** One canonical state field, `lifecycle`, with six values: `proposed → active → succeeded | superseded | abandoned | failed`. UI can render kind-specific labels at display time (e.g. show "completed" for an Action's `succeeded`) but nothing is stored.
- **Alternatives rejected:** Per-kind status enums only (synonym sprawl, hard to query "everything currently active" across kinds); dual `lifecycle` + `status` field (originally chosen — superseded because the `status` alias was always set from `lifecycle` and added no information, only coupling).
- **Why:** Cross-kind queries become trivial; one source of truth instead of two.
- **Ref:** SCHEMA.md §3.1.

### D-008 — Per-Doco `schema_version` (additive evolution)

- **Chosen:** Each Doco records `schema_version`. Schema evolution is additive (new fields don't invalidate old data); breaking changes require an explicit version bump.
- **Why:** Different Docos can adopt new features at their own pace. Forward-compat hatch.
- **Open:** Whether to allow only-additive forever vs explicit migrations. (See §13.)
- **Ref:** SCHEMA.md §3, §11 open questions.

---

## 3. Node types (10 total)

### D-009 — Final node type list

- **Chosen:** `principal`, `doco`, `intent`, `rule`, `decision`, `action`, `reasoning`, `evaluation`, `reference`, `tag`. (10 kinds total.)
- **Alternatives rejected:** Separate `Constraint` + `Assertion` (collapsed → Rule); `Membership` as a node (collapsed → MemberOf edge); `Plan`, `Question`, `Claim`, `Scope` as first-class entities (deferred — emergent or covered by simpler mechanisms).
- **Why:** Each kind earns its place by having distinct shape and lifecycle. Aggressive consolidation kept the surface narrow.
- **Ref:** SCHEMA.md §4.

### D-010 — Constraint + Assertion → unified `Rule` with `phase`

- **Chosen:** A single `Rule` entity with a `phase: declared | pre | post | invariant` field. `declared` is the old Constraint (policy that holds); `pre|post|invariant` is the old Assertion (runtime evaluation point).
- **Alternatives rejected:** Keep them separate (genuine duplication; same predicate language, same scope-matching, same Evaluation production).
- **Why:** Same conceptual thing — "a statement of correctness" — distinguished only by *when* it's evaluated. Simpler vocabulary.
- **Ref:** SCHEMA.md §4.4.

### D-011 — Membership as edge, not node

- **Chosen:** `Doco.members[]` array carries `{principal_id, role, permissions}` structs. The index materializes these as `MemberOf` edges with role and permissions as edge properties.
- **Alternatives rejected:** First-class `Membership` entity with its own ID and lifecycle (no genuine independent lifecycle worth a node).
- **Why:** Graph-native; reduces node-type count from 11 → 10; aligns with Kuzu mapping when we adopt it.
- **Ref:** SCHEMA.md §4.2 (Doco entity), §6.1 fields-as-edges.

### D-012 — Reasoning is a first-class entity (multi-author capable)

- **Chosen:** Reasoning lives in its own file with `premises`, `inference`, `confidence`, `uncertainty` fields. Multiple Reasonings can attach to the same Decision (different authors, contested reasoning, post-hoc revision).
- **Alternatives rejected:** Collapse Reasoning into a `rationale` string on Decision/Action.
- **Why:** Multi-author critique is a target use case; agents and people both produce reasoning chains; contested reasoning is itself queryable evidence.
- **Ref:** SCHEMA.md §4.7.

### D-013 — Decision and Rule are distinct (don't unify)

- **Chosen:** Keep separate. Decision = a recorded choice (one-shot, with rejected alternatives, retrospective). Rule = a constraint that holds (continuous, evaluated repeatedly, predicate-bearing).
- **Test that decides:** "Can this produce an Evaluation?" → Rule. "Does this carry rejected alternatives?" → Decision.
- **Why:** Different lifecycle, different shape (Decision has `alternatives[]`, Rule has `predicate`). The bug-fix pattern (Decision spawns regression-guard Rule via `born_from`) shows how they pair.
- **Ref:** SCHEMA.md §4.4 (Rule), §4.5 (Decision); explained in conversation, not yet in a dedicated section.

---

## 4. Edges and relationships

### D-014 — Drop `JustifiedBy` (use `Concludes` only)

- **Chosen:** Single source-of-truth field `Reasoning.conclusion_ref` produces a `Concludes` edge (Reasoning → Decision/Action). Index makes it traversable in both directions.
- **Alternatives rejected:** Keep both `Decision.reasoning_id` (→ JustifiedBy) and `Reasoning.conclusion_ref` (→ Concludes) as parallel sources.
- **Why:** Two fields modeling the same relationship is genuine duplication; index resolves directionality.
- **Ref:** SCHEMA.md §6, §6.1.

### D-015 — Drop `Bounded_by` edge

- **Chosen:** Use `AppliesTo` (Rule → entity) only. Don't model the inverse Action-side `Bounded_by` separately.
- **Alternatives rejected:** Keep both directions for query convenience.
- **Why:** Graph traversal works either direction; one edge type is enough.
- **Ref:** SCHEMA.md §6.

### D-016 — `born_from` as a generic provenance edge

- **Chosen:** Any entity can carry a `born_from: <other_entity_id>` field. Materializes as a `BornFrom` edge. Canonical use: regression-guard Rules `born_from` the bug-fix Decision.
- **Why:** "X exists because of Y" is a recurring pattern across Decision-spawns-Rule, ADR-spawns-Rule, etc. Naming it makes it queryable.
- **Ref:** SCHEMA.md §3 (common field), §6 (edge), §6.1 (mapping).

### D-017 — Fields-as-edges convention

- **Chosen:** Any field whose value is an entity ID (or list of IDs) is automatically materialized as an edge in the index. Field name → edge type. The frontmatter file is source-of-truth; index re-derives.
- **Why:** Eliminates the need for a separate edge schema. Adding a new ID-valued field automatically gets indexed. Source files stay minimal; queries stay rich.
- **Ref:** SCHEMA.md §6.1 (full mapping table).

---

## 5. Naming conventions

### D-018 — Per-node handle field

- **Chosen:** Each node kind has a stable, readable handle alongside its ULID. Conventions:
  - `Principal.username` — GitHub login (people) or `{owner_username}/{ISO_timestamp}` (agents).
  - `Doco.slug` — `{owner_username}/{doco_name}`.
  - `Intent / Rule / Decision`: `slug` (kebab-case, derived from primary content, deduped).
  - `Reference.locator` — the external URL/path itself.
  - `Tag.name` — kebab-case.
  - `Action / Reasoning / Evaluation` — *no slug*; refer by ID.
- **Why:** People get readable handles; transient/event-shaped entities (Action, Reasoning, Evaluation) don't need them.
- **Ref:** SCHEMA.md §7 (and conversation; not yet a dedicated subsection).

### D-019 — Slugs are immutable once set

- **Chosen:** Editing the title/summary does *not* regenerate a slug. Renames create a new slug; old becomes an alias.
- **Why:** URL stability, cross-reference robustness.
- **Ref:** Conversation.

### D-020 — URL form

- **Chosen:** `doco://{doco_slug}/{node_type}/{slug_or_id}`. Both slug and ID resolve.
- **Why:** Agents link by ID (forever-stable); people link by slug (readable).
- **Ref:** Conversation.

### D-021 — Reserved tag conventions

- **Chosen:** Reserved tag names with semantic meaning recognized by tooling/lints:
  - `tag_adr` — Decision is published as an ADR (sets `number` field).
  - `tag_bugfix` — Decision resolves a bug; expected to spawn a `tag_regression_guard` Rule.
  - `tag_regression_guard` — Rule born from a bugfix Decision.
  - `tag_adr_consequence` — Rule born from an ADR's stated consequence.
  - `tag_userflow` — Decision is part of a user-flow design chain.
  - `scope_*` — local scope (used in `applies_to` selectors).
- **Why:** Tooling can enforce conventions; vocabulary stays consistent across teams.
- **Ref:** SCHEMA.md §4.10 (Tag).

### D-022 — Optional `number` on Decision (ADR-style)

- **Chosen:** Decisions can carry an optional `number: "ADR-0042"` when promoted to ADR status. Set when `tag_adr` is applied.
- **Why:** ADR teams care about sequential identifiers; people get short references; agents keep ULIDs.
- **Ref:** SCHEMA.md §4.5.

---

## 6. Query layer

### D-023 — Tiered architecture: source files + derived index

- **Chosen:** Source files (`intents/`, `rules/`, ...) are git-tracked and authoritative. A local `.doco/cache.db` SQLite index is per-clone, regenerable, *not* git-tracked.
- **Why:** Source is durable + diffable; index is fast. Wiping the index never loses data. Each clone rebuilds locally.
- **Ref:** SCHEMA.md §8.1.

### D-024 — Index = SQLite + FTS5 (Kuzu deferred)

- **Chosen:** SQLite with FTS5 virtual table for full-text. Recursive CTEs for graph traversal.
- **Alternatives rejected (for v0.x):** Kuzu (newer; smaller ecosystem), Memgraph/Neo4j (server-based; ops cost), TerminusDB (would require DB-as-source-of-truth).
- **Why:** Priority 1 — agents are vastly more fluent in SQL than Cypher (training data volume). Plus zero-ops embedded model. Index is rebuildable, so future swap to Kuzu is cheap engineering.
- **When to revisit:** Profiling at real scale (1M+ entities, 5+ hop traversals) shows recursive-CTE traversal as the bottleneck → swap to Kuzu.
- **Ref:** SCHEMA.md §8.2, §8.8.

### D-025 — Edges as adjacency table

- **Chosen:** Single `edges(from_id, from_node_type, to_id, to_node_type, edge_type)` table. Recursive CTEs for traversal.
- **Why:** Standard relational-graph pattern. Works to ~1M edges. Simple to reason about.
- **Ref:** SCHEMA.md §8.2.

### D-026 — Denormalized scope-selector caching

- **Chosen:** When a Rule is created or its `applies_to` selector changes, evaluate once and store matches in `scope_match` table. Bump `selector_rev`.
- **Alternatives rejected:** Evaluate selectors on every read (linear in selectors × entities — slow at scale).
- **Why:** Rules are read-heavy, written rarely; constant-time lookup is worth the on-write cost.
- **Ref:** SCHEMA.md §8.5.

### D-027 — SQL is the primary agent query surface

- **Chosen:** Agents query the index via SQL. The schema is self-describing via `schema/doco.schema.json`.
- **Alternatives rejected:** Custom Doco DSL as primary (one more thing to teach); Cypher (less SQL-like, less ubiquitous).
- **Why:** Priority 1 — SQL is universally trained; no DSL to learn; the schema is discoverable from inside the Doco.
- **Future:** A high-level NL→SQL helper is welcome but not the primary surface.
- **Ref:** SCHEMA.md §8.6.

---

## 7. Scoping

### D-028 — Four scope cases, three mechanisms

- **Chosen:**
  - **Global within Doco** — `applies_to: { all: true }`.
  - **Local sub-scope** — reserved `scope_*` tag prefix (`scope_auth`, `scope_payments`, ...).
  - **Hierarchical scopes** — *deferred*; promote `Scope` to first-class entity only if tag-only proves insufficient.
  - **Cross-Doco** — `imports` field in `doco.yaml`.
- **Why:** The first two cases are handled without new entity types. Hierarchical is deferred to avoid premature complexity. Cross-Doco gets a real mechanism.
- **Ref:** SCHEMA.md §9.

### D-029 — Cross-Doco imports: pinned, namespaced, additive

- **Chosen:** `imports[].doco` references another Doco at a pinned `ref` (git tag/branch/commit), under a local namespace (`as: policy`). Imported entities get namespaced IDs (`policy:rule_01H...`).
- **Resolution:** Matching is **additive** (local + imported Rules all apply); override is **explicit** (local Rule with `superseded_by: policy:rule_...`).
- **Why:** Same model as code package managers — versioned, explicit, overrideable, auditable. Nothing silently disappears.
- **Ref:** SCHEMA.md §9.4.

---

## 8. Rule discovery

### D-030 — Five-strategy retrieval

- **Chosen:** Rule discovery combines (1) structural match via `scope_match`, (2) tag overlap, (3) reference-graph expansion, (4) semantic embedding search, (5) glossary expansion. Strategies 1–3 are precision-tight (block on `must` violations); 4–5 are advisory.
- **Why:** Vocabulary mismatch is the hardest case. Multi-strategy ensures coverage without flooding agents with false positives in the blocking layer.
- **Ref:** SCHEMA.md §10.1.

### D-031 — Vector embedding index alongside FTS5

- **Chosen:** `rule_embeddings` virtual table (sqlite-vec) lives in the same `.doco/cache.db` as the SQL tables. `cache.embedding_version` tracks model version; bumping triggers re-embedding.
- **Why:** Embedded with the index; one cache to manage; same rebuild story.
- **Ref:** SCHEMA.md §10.2.

### D-032 — `glossary.yaml` as flat config

- **Chosen:** Optional `glossary.yaml` at Doco root with term → synonyms mapping. Not a node type.
- **Alternatives rejected:** First-class `GlossaryEntry` entity (overkill; per-term version control isn't yet a need).
- **Why:** Simple file, easy to author, easy to import; promote to entity if per-term lineage becomes valuable.
- **Ref:** SCHEMA.md §10.2.

### D-033 — Hard/soft separation in discovery

- **Chosen:** Structural matches *block* (precision-tight). Tag/reference/semantic matches are *advisory* — surfaced as context, never enforced.
- **Why:** The runtime gate stays precise (no false positives blocking work); the discovery layer stays generous (low false negatives).
- **Ref:** SCHEMA.md §10.1.

---

## 9. Identity & authentication

### D-034 — People sign in exclusively via GitHub

- **Chosen:** GitHub OAuth is the only sign-in for people. No email/password, no magic links.
- **Alternatives rejected:** OIDC/SAML (deferred — adds complexity for v0.x); email+password (extra surface area to secure).
- **Why:** Universal among target users (developers, AI-tool teams). Locks identity to a verified external authority. Aligns with git-repo mental model.
- **Open:** Whether GitHub-only is permanent or v0 simplification (see §13).
- **Ref:** PLANNING.md §2.1.

### D-035 — Agents can only be created via invitation tokens

- **Chosen:** No agent self-signup. Every agent's `Principal` is created via a token issued by a person (or an agent already invited by a person, transitively).
- **Why:** Trust invariant: every agent's `owner_id` chain terminates at a person. Lintable, queryable.
- **Ref:** PLANNING.md §2.2, §3.

### D-036 — Username convention

- **Chosen:** Humans = GitHub login. Agents = `{owner_username}/{ISO_timestamp}` where the timestamp is the moment the agent's Principal was created.
- **Why:** Lineage visible at a glance; multiple agents under one owner are auto-distinguishable.
- **Ref:** PLANNING.md §2.3, SCHEMA.md §4.1.

### D-037 — Token lifecycle: 5-min invitation → long-lived session

- **Chosen:** Two-phase tokens: invitation token (5-minute single-use, URL-shareable) → session token (no default expiry, stored in `DOCO_TOKEN` env var, revocable).
- **Alternatives rejected:** Single token type (loses bootstrap-vs-runtime separation); session tokens with default TTL (operational toil for long-running agents).
- **Why:** Narrow blast radius for leaked invite URLs; agents can persist session tokens for ongoing work.
- **Ref:** PLANNING.md §3.1, §3.2.

### D-038 — Token revocation cascades strictly (default)

- **Chosen:** Revoking a session token invalidates all session tokens whose ancestry chain passes through it. Per-Doco override flag for "scoped" mode (only revoke the named token).
- **Why:** Strict-by-default is safer for security incidents.
- **Open:** Per-Doco override is real but not deeply specified yet (§13).
- **Ref:** PLANNING.md §3.3, §6.

### D-039 — Tokens are stored externally, not in the Doco

- **Chosen:** Token *values* live in the API server's encrypted database. The Doco records *which* Principals exist and the lineage; the index reflects edges.
- **Why:** Source-controlled secrets are bad practice; tokens shouldn't be in git.
- **Ref:** PLANNING.md §3.3.

### D-040 — Only people can delete Docos

- **Chosen:** Built-in system Rule (`rule_system_only_people_delete`) blocks `delete_doco` Actions when `actor.is_agent == true` (or `actor.type == 'person'` in current schema).
- **Why:** Single people-only operation; everything else (create, edit, archive, transfer) is open to both.
- **Ref:** PLANNING.md §2.4.

---

## 10. Product flows

### D-041 — Two onboarding paths: greenfield and brownfield

- **Chosen:** `doco init` (greenfield) and `doco init --existing` (brownfield). Brownfield asks an explicit fork: backfill past decisions, or document forward-only.
- **Why:** The brownfield case is half of real adoption; surfacing the choice early avoids regret.
- **Ref:** PLANNING.md §1.

### D-042 — Backfill workflow with `proposed` quarantine

- **Chosen:** Importers (Slack, email, Figma, Notion, code, agent transcripts) extract candidate entities, all entering with `lifecycle: proposed`. A review UI bulk-accepts/rejects; only on accept do entities flip to `active`/`accepted`.
- **Why:** Extracted entities are lossy; quarantine prevents bad data from entering the live alignment graph; provides a clear "complete-baseline" event.
- **Ref:** PLANNING.md §4.

### D-043 — Each backfilled entity carries a `Reference` to its source

- **Chosen:** Importer always attaches a Reference (Slack permalink, Figma node ID, PR URL, etc.) to the proposed entity.
- **Why:** Auditable provenance; re-running an importer is idempotent (same source → same proposed entities).
- **Ref:** PLANNING.md §4.2.

### D-044 — API-first; web is a consumer

- **Chosen:** Public REST + JSON API at `/api/v1/...`. The web interface consumes it; no parallel implementation.
- **Why:** Anything a person can do, an agent can do. Feature parity is mechanical. OpenAPI schema is generated and self-documenting.
- **Ref:** PLANNING.md §5.1, §5.2.

### D-045 — Recent-changes feed = home; graph = secondary

- **Chosen:** Default home view is a chronological feed of Actions/Decisions/Evaluations (filterable by kind/actor/time/topic). Graph is a per-entity drill-down ("show neighborhood"), not a primary navigation.
- **Why:** Graph navigation acknowledged as "doesn't work well" as a primary entry point. Feed mirrors the GitHub home experience users already understand.
- **Ref:** PLANNING.md §5.3.

---

## 11. Edge case patterns to implement

These are conventions that emerged but aren't separate decisions — they're instances of how the schema is *used*:

- **Bug fix → regression Rule.** Every meaningful bug-fix Decision should produce at least one `tag_regression_guard` Rule via `born_from`. Lints can flag fix Decisions without a guard. (PLANNING.md §6 item 3, conversation around bug resolution.)
- **ADR consequence → enforced Rule.** When an ADR has machine-checkable consequences, those become Rules with `tag_adr_consequence` and `born_from: <adr_decision_id>`. (Conversation around ADRs.)
- **Multi-author Reasoning.** Multiple Reasoning entities can attach to the same Decision (different authors, contested chains). Both are preserved; the team picks based on evidence. (SCHEMA.md §4.7.)
- **Agent ancestry chain.** `MATCH path = (a:Principal {is_agent:true})-[:OwnedBy*]->(person:Principal {is_agent:false}) RETURN path` should always return a path for every agent. Lint for orphan agents.

---

## 12. What an implementer needs to build

Roughly, in implementation-order:

1. **CLI core** — `doco init`, `doco init --existing`, `doco show`, `doco query`. (PLANNING.md §1.)
2. **Source-of-truth layer** — file readers/writers for entity YAML+Markdown; schema validation against `doco.schema.json`. (SCHEMA.md §2, §3, §4.)
3. **Index layer** — SQLite + FTS5 cache builder; `edges` adjacency table; `scope_match` denormalization; incremental updater on file change / git commit. (SCHEMA.md §8.)
4. **Identity** — GitHub OAuth for people; invitation-token + session-token issuance for agents; `DOCO_TOKEN` env-var consumption; token revocation. (PLANNING.md §2, §3.)
5. **API server** — REST CRUD + query + discovery + events stream; OpenAPI generation. (PLANNING.md §5.2.)
6. **Web app** — recent-changes feed, list-by-kind, search (Cmd-K + full page), entity detail page with neighborhood preview, graph view as secondary. (PLANNING.md §5.3.)
7. **Importers** — Slack, email, Figma, Notion, GitHub PRs, agent transcripts. Each runs idempotently and emits `lifecycle: proposed` entities with Reference back-pointers. (PLANNING.md §4.)
8. **Rule discovery** — `doco find-rules` CLI + API endpoint; vector embedding index; `glossary.yaml` expansion. (SCHEMA.md §10.)
9. **System Rules + lints** — `rule_system_only_people_delete`; orphan-Reasoning lint; bug-fix-without-regression-guard lint; agent-without-person-ancestor lint. (PLANNING.md §2.4, §11 above.)

---

## 13. Open questions — all resolved 2026-05-08

All 13 questions below were resolved on 2026-05-08 in a single batch decision-making
session before phase 1 implementation began. Resolution links by question
number:

| # | Resolved by |
|---|---|
| 1 | [ADR-048](decisions/decision_01KR441EA2VSXQ1GHX8AKSV2VJ.md) — JSON DSL for v0 |
| 2 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — keep `type` field |
| 3 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — keep current names |
| 4 | [ADR-050](decisions/decision_01KR441EA4F19H61WSEDAYAHVH.md) — additive within major |
| 5 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — no per-entity visibility |
| 6 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — strict cascade only |
| 7 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — v0 simplification |
| 8 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — Token stays external |
| 10 | [ADR-051](decisions/decision_01KR441EA55CCPH23ZE3FF1CQC.md) — drop `conclusion_node_type` |
| 11 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — Plan/Question stay deferred |
| 12 | [ADR-054](decisions/decision_01KR441EA8QFSX5Q6CHNVCKMJ0.md) — add PII rule in phase 3 |
| 13 | [ADR-049](decisions/decision_01KR441EA3123BT1YV4ZKAFM9C.md) — Tier B (1k–100k entities) |

Original question framings are preserved below for historical reference.

---

1. **Predicate language for Rules.** CEL? Lisp-like S-expr? A small JSON DSL? Defer until 3–5 real Rules exist to test against. (SCHEMA.md §11 #2.)
2. **`is_agent` boolean vs `actor_kind` enum on User/Principal.** Currently the schema still has `Principal.type: person | agent`. Conversation suggested renaming to `is_agent: bool` for clarity, but the rename hasn't been applied. Pick one and apply uniformly.
3. **Rename `principal` → `user`?** Discussed in conversation; not applied. Same for `evaluation → check`, `reference → source`. Decide whether to apply, and if so, do it consistently across SCHEMA.md, PLANNING.md, file paths, and ID prefixes.
4. **Schema versioning policy.** Strict additive-only forever, or allow breaking changes with explicit migration tooling? (SCHEMA.md §11 #6.)
5. **Per-entity visibility.** Currently visibility is Doco-level only (public/private). Allowing per-entity visibility (e.g., private Intent in a public Doco) is doable but non-trivial. (SCHEMA.md §11 #7.)
6. **Token revocation cascade override.** Strict-cascade is the default (D-038). The "scoped" override flag is mentioned but not specified — define semantics, persistence, and audit trail. (PLANNING.md §6 #2.)
7. **GitHub-only sign-in: hard constraint or v0 simplification?** OIDC/SAML support is deferred but not killed. Decide when adoption signal demands broader support. (PLANNING.md §6 #1.)
8. **`Token` as a first-class entity?** Currently kept external (server DB). Promote to entity if Doco-internal queries on token metadata become valuable. (PLANNING.md §6 #6.)
9. **Hierarchical Scope entity.** Deferred. Promote only when tag-only model proves insufficient. (SCHEMA.md §9.3.)
10. **`conclusion_node_type` on Reasoning is redundant** (the conclusion's ID prefix carries the type). Could be dropped. Mentioned in conversation; not yet acted on.
11. **`Plan` and `Question` as entities.** Both deferred; Plan is emergent, Question is folded into Decision. Promote only if real use cases demand. (SCHEMA.md §11 #8, #9.)
12. **Public-Doco PII leakage in agent ancestry chain.** Confirm `Principal.identifier` and `display_name` can't leak email patterns. Add a Rule. (PLANNING.md §6 #4.)

13. **v0 scale target.** What scale (entities, edges, latency budgets) does Doco target for v0.x, and what are the swap triggers between scale tiers? Tentative direction: **Tier B (1k–100k entities, ≤ 1M edges)** — covers the team-sized brownfield-backfill case (D-042) without committing to Tier C engineering ahead of demand. Specifically blocks: centrality compute architecture (in-process `igraph`/NetworkX vs. server-based graph DB), the D-024 swap-trigger framing (currently "1M+ entities, 5+ hop traversals" — but is that what we *target*, or what we *tolerate*?), runtime-check latency budgets (sub-10ms per Action stated in §8.3 — at what tier?), and analytics cadence (per-commit / on-demand / periodic). Raised 2026-05-08 during PageRank-compute discussion.

---

## Appendix — Decision count by area

| Area | Count |
|---|---|
| Foundation | 5 |
| Schema shape | 3 |
| Node types | 5 |
| Edges | 4 |
| Naming | 5 |
| Query layer | 5 |
| Scoping | 2 |
| Rule discovery | 4 |
| Identity & auth | 7 |
| Product flows | 5 |
| **Total settled decisions** | **54** |
| Open questions | 0 (all resolved 2026-05-08) |
