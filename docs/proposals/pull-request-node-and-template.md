# Proposal: A Pull Request node type + capture template for Doco

> **Status: NOT adopted — superseded by the References model (decided
> 2026-05-31).** This document proposed giving pull requests a dedicated
> `pull_request` node type. That recommendation was **declined.** The project
> owner chose to model a PR as an ordinary `reference` node — *no new node
> type* — and the GitHub integration that shipped follows that decision. This
> file is kept as the design record *behind* the decision, not as a description
> of what exists.
>
> **What actually shipped (the source of truth):** a PR becomes a `reference`
> node — `ref_type: "url"`, `locator` = the PR URL (the idempotency key),
> prose = title + body — with lifecycle `open → drafting`,
> `merged → asserted/succeeded`, `closed-unmerged → retired`, linked to the work
> it implements via the existing `implemented_by` edge. The importer is
> idempotent on the PR URL (re-sync upserts, never duplicates). See
> `packages/web/app/lib/github-pr-import.server.ts`, `github-app.server.ts`,
> `github-webhook.server.ts`, `github-backfill.server.ts`, and the Integrations
> panel (`app/routes/$docoHandle.settings.integrations.tsx`).
>
> The `Doco-Implements:` / `Doco-Fixes:` trailer auto-wiring described below is
> **not implemented** — it remains a proposal. Everything past this banner is
> the original (un-adopted) node-type design, retained for the record.
>
> _Update (2026-05-31):_ since this draft, the repo dropped the five promoted
> node→node FK columns (`parent_intent_id`, `decided_by`,
> `superseded_by_decision_id`, `actor_id`, `template_id`) in migration 074
> (#694, #695). First-class edges — authored via a node field and reconciled by
> the capture path into an `origin='field'` edge, with the value retained in
> `data` — are now the **single source of truth for every node→node
> relationship**; no relationship is a promoted FK column anymore. This
> proposal already follows that model: every PR connection below (`implements`,
> `fixes`, `intent_ids`, `decision_ids`, `gated_by`, `relates_to`, `born_from`,
> `superseded_by`) is an authored field the engine projects into an edge, so the
> PR node stores no FK pointer of its own — it just registers two more
> `RELATION_KINDS`. The sections below are reconciled with that change.

## TL;DR

- **Give pull requests a first-class home in Doco.** Today a PR can only be a
  `reference` node (`ref_type: "url" | "ticket"`) — a deliberately-minimal
  *citation* whose modeled contract is "immutable snapshot; correct by
  superseding." That's the wrong abstraction for an object that changes
  `open → merged → closed`, accrues links over its life, and needs idempotent
  re-sync.
- **Original recommendation — _not adopted_: add a dedicated `pull_request`
  node type** with a small, structured field set, a clear lifecycle mapping, and
  PR-owned link fields so one PR node can "point to" the BPM event it
  implements, the bug it fixes, the decision it enacts, and the intent it
  serves. _(The project chose the `reference` model instead — see the banner
  above. The rest of this section explains the design that was weighed and
  declined.)_
- **Reuse the graph that already exists.** `implemented_by` was written *for
  this* ("Node is implemented by one or more code-artifact Reference nodes
  (PRs, commits, files, lines)"). PR connections map onto existing edges
  (`serves`, `enacts`, `gated_by`, `relates_to`, `born_from`, `superseded_by`)
  plus two PR-side authoring fields (`implements`, `fixes`) — all of them
  authored as node fields and projected to first-class edges, the same
  mechanism that now backs every node→node relationship since the FK columns
  were dropped (#694).
- **GitHub auto-import is the forcing function for the design.** Idempotent
  upsert keyed by the PR URL, a field-mapping table, and a machine-readable
  trailer convention (`Doco-Implements:`, `Doco-Fixes:`) in a recommended
  `.github/PULL_REQUEST_TEMPLATE.md` let the importer wire PRs to BPM
  events/bugs/decisions with zero extra human steps. A mutable node type is
  what makes idempotent re-sync clean; a Reference's snapshot/supersede contract
  is not.

---

## 1. Why PRs deserve a first-class node

Git records *what* changed. Doco records *why*. The pull request is the seam
between them — it is where a code change is justified, reviewed, linked to the
work item, and shipped. Capturing PRs in Doco lets you answer questions that
neither git nor GitHub answers well on their own:

- "Which PR shipped this BPM event / this decision?" (`implemented_by`)
- "What fixed this bug, and what rule did we add so it can't recur?"
- "Show every merged PR that served Intent X last quarter."
- "This PR touched the payments flow — what decisions and rules govern it?"

The request is explicitly: PRs that can be **searched** and **connected to
other nodes** (a BPM event a PR implements; a bug a PR fixed), with a path to
**auto-import from GitHub**.

### What's there today, and the gap

| Capability | Today | Gap |
|---|---|---|
| Represent a PR | `reference` node, `ref_type: "url"`/`"ticket"`, `locator` = PR URL | No PR-specific fields (state, author, reviewers, merge SHA, branches, stats) |
| Link a PR to a node it ships | `implemented_by` edge (owned by the **target** node) | Authoring is target-centric; a PR can't "point to" its own targets, and import would have to PATCH N target nodes per PR |
| Mutability | References are **modeled as immutable snapshots** (supersede to correct)† | A PR changes `open → merged`; a supersede-don't-edit contract forces churn on every state change — fatal for idempotent GitHub sync |
| Import from GitHub | OAuth sign-in only (`auth.github.*`) | No inbound webhook / PR backfill infrastructure exists |

The abstraction mismatch is the crux: the thing we most want (re-syncable PRs
that accrue links over their life) runs against the Reference contract of
"snapshot, then supersede."

> † **On "frozen":** Doco's *"frozen claims, mutable records"* model
> (`decision_01KRKEPRAMM9QSSEJ2X5FHPESJ`) originally hard-froze a claim's body
> once it reached `accepted`/`retired`. That built-in freeze was already
> permissive in code (`validatePatch` always allowed), and this change removes
> the vestigial machinery outright — every node and edge is editable at any
> lifecycle; integrity comes from the append-only audit log + immutable version
> snapshots, not from freezing the current row. So the case for a dedicated PR
> type rests on its rich structured fields, idempotent upsert ergonomics, and
> first-class searchability — not on any freeze.

---

## 2. Best practices for documenting a pull request

A synthesis of widely-adopted PR conventions (GitHub linked-issues, Conventional
Commits, and common `PULL_REQUEST_TEMPLATE.md` practice), framed as "what Doco
should capture":

1. **A semantic, imperative title.** `fix(auth): reject expired device codes`,
   not "fixes". Conventional-Commit prefixes (`feat/fix/refactor/docs/chore/
   perf/test/build/ci/revert`) make titles searchable and feed a `change_type`.
   → capture as `title` + `change_type`.
2. **What *and* why, not just what.** A summary plus the motivation/context the
   diff can't show. → the prose `pull_request` field.
3. **Link the work item.** GitHub closing keywords (`Closes #123`, `Fixes #123`,
   `Resolves #123`) auto-close issues and are the single most useful machine
   signal in a PR body. → drives `fixes` and linked-issue references.
4. **State the type and blast radius.** Type of change + an explicit
   breaking-change callout. → `change_type`, `breaking`.
5. **Show how it was verified.** Test plan, repro steps, screenshots for UI.
   → `pull_request` prose; ties to Doco `eval` nodes via `relates_to`.
6. **Name the risk and the rollback.** Especially for migrations/deploys.
   → `risk` + prose; can spawn a `rule`.
7. **Keep PRs small and focused;** call out when a PR is unavoidably large.
8. **Give reviewers a map** — what to look at first, what's out of scope.
9. **Keep the description current;** the merged state is the record of truth.
   → import keeps the node in sync.
10. **Make links machine-readable.** Trailers (`Co-authored-by:`, and here
    `Doco-Implements:` / `Doco-Fixes:` / `Doco-Enacts:`) so a human writes a
    sentence and a tool gets a graph edge. → §6 trailer convention.

Items 1–6 and 10 map cleanly to fields and edges below; 7–9 are authoring
discipline a `PULL_REQUEST_TEMPLATE.md` (§7) nudges.

---

## 3. Design: how a PR fits Doco's graph

### 3.1 The one real fork — dedicated type vs. enriched Reference

| | **A. Dedicated `pull_request` type (recommended)** | B. Enrich `reference` (`ref_type: "pull_request"`) |
|---|---|---|
| Structured fields (state, author, reviewers, SHA, branches, stats) | First-class, queryable | Would bloat the deliberately-minimal Reference shape |
| Mutability for `open → merged` | Native (`PATCH` upsert) | Fights the snapshot/supersede contract → churn |
| Idempotent GitHub re-sync | Natural (upsert by locator) | Painful (new node each change) |
| Search/filter/perspectives | First-class segment `/api/pull_requests.json` | Mixed in with all references |
| Implementation cost | Higher: registry + entity + capture fn + spec + UI icon | Lower: one enum value + edges |
| Fits existing `implemented_by` intent | Yes (PR node is a valid target) | Yes (that edge already names PRs) |

**Recommendation: A.** PRs have a distinct lifecycle and a rich, structured
shape that the minimal, snapshot-modeled Reference type actively fights, and
idempotent import is a hard requirement that a purpose-built mutable type
satisfies cleanly. **B is the
sensible on-ramp** (Phase 0, §8) if we want value this week without new
machinery — and a PR node remains a valid `implemented_by` target either way,
so B→A is a forward-compatible migration, not a rewrite.

### 3.2 Lifecycle & outcome mapping

The PR's GitHub `state` is the unambiguous, native signal; Doco
`lifecycle`/`outcome` are derived projections (so existing freshness/health
queries keep working):

| GitHub state | `state` field | `lifecycle` | `outcome` | Notes |
|---|---|---|---|---|
| open, draft | `open` | `drafting` | — | `draft: true` |
| open, ready | `open` | `drafting` | — | still in-flight, may change |
| merged | `merged` | `asserted` | `succeeded` | it shipped; now a settled fact |
| closed, unmerged | `closed` | `retired` | `failed` | or set `superseded_by` if replaced rather than abandoned |

This is a **decision point** (see §9): an alternative reading treats a merged PR
like a completed `action` (which defaults to `lifecycle: "retired"`). We pick
`asserted` for merged so PRs stay visible as live facts in search; `state`
remains the source of truth regardless.

### 3.3 Connections — reuse first, add two fields

Map each desired link onto an **existing** relation kind; introduce the minimum
new surface. (Relation kinds live in `graph-authoring-contract.server.ts`.)

| PR points to… | Field on the PR | Relation kind | New? |
|---|---|---|---|
| Intent it serves | `intent_ids` | `serves` | existing |
| Decision it enacts / cites | `decision_ids` | `enacts` | existing |
| Rule that gated it | `gated_by` | `gated_by` | existing |
| Peer "see also" (related PR, doc) | `relates_to` | `relates_to` (first-class `/api/edges.json`) | existing |
| Node it was born from (e.g. an incident) | `born_from` | `born_from` | existing |
| **BPM event / Action / State / Decision / Intent it implements** | `implements` | `implemented_by` (inverse) | **authoring field** |
| **Bug / incident it fixes** | `fixes` | `fixed_by` (inverse) | **new edge** |

Design intent for the two PR-side fields:

- **`implements`** is the PR-owned authoring face of the *existing*
  `implemented_by` edge. The codebase already says "Decisions/ADRs are
  implemented by the PRs that ship them." Rather than make importers PATCH
  every target node, the PR sends `implements: [<target ids>]` and the engine
  writes the canonical target-owned `implemented_by` edge (one stored edge, two
  views). This is the same authoring-field → `origin='field'` edge projection the
  capture path now uses for the five formerly-promoted node→node columns
  (`has_parent`, `decided_by`, `superseded_by`, `performed_by`, `templated_by`,
  dropped in migration 074) — the PR registers two more relation kinds, it
  stores no FK pointer of its own. A "BPM event" is just whichever node models
  it in this Doco — an
  `action` or `state` in the BPMN perspective, or the `decision` that defines
  it.
- **`fixes`** is a new edge (inverse `fixed_by`), kept distinct from
  `implements` because (a) it mirrors GitHub's `Fixes #N` exactly and (b) "what
  fixed this bug?" is a first-class query. Doco has no `bug` node type, so the
  bug is modeled as the node that best fits this Doco's practice — typically a
  `log` (the observed failure) or an external-issue `reference`; `fixes` accepts
  any node id. The preventive **rule** that "emerged from the bug fix" is
  captured separately and linked via `gated_by`/`enacts`.

Both new fields are `cardinality: "many"`, owner `pull_request`, and should be
registered in `RELATION_KINDS` with `owners: ["pull_request"]` so setting them
on the wrong node type is rejected (not silently dropped) by
`unsupportedRelationFieldError`. Like every managed relation, they author a node
field that the capture path reconciles into an `origin='field'` edge — there is
no node→node FK column to add (those were all dropped in #694).

---

## 4. The template (capture spec)

Written in the exact house style of the existing specs in
`packages/web/app/routes/$docoHandle.api.$type[.]txt.tsx`, so it can be dropped
in next to `decisions` / `actions` / `references`.

```
# Doco — Capture a Pull Request (single call)

A Pull Request is a code-change proposal that links shipped work back to the
intents, decisions, BPM events, and bugs it touches. PRs are mutable: capture
on open (drafting) and PATCH (or re-import) as they progress to merged/closed.
Idempotent on `locator` — re-capturing the same PR URL upserts, never dupes.

ENDPOINT
  POST ${baseUrl}/${handle}/api/pull_requests.json
  Content-Type: application/json

PRINCIPAL ID CONVENTION
  Request bodies use principal ids only (*_principal_id / *_principal_ids).
  created_by is provenance from the authenticated session or token (for an
  importer, the bot/API key) — never send it. author_principal_id is the
  human who opened the PR; map it from the GitHub login via the stored
  GitHubIdentity, or omit for an external/unmapped author.

  LIFECYCLE NOTE
  open → drafting; merged → asserted (outcome succeeded);
  closed-unmerged → retired (outcome failed, or set superseded_by).
  The native `state` field is the source of truth; lifecycle/outcome are
  derived. Removal is never a hard delete — transition to "retired".

BODY (JSON)
  pull_request        required   full prose: summary + the WHY the diff can't show
  title               required   PR title (semantic / Conventional-Commit style encouraged)
  locator             required   canonical PR URL — the idempotency key
                                 (e.g. https://github.com/org/repo/pull/123)
  state               optional   "open" | "merged" | "closed"; default "open"
  draft               optional   boolean — GitHub draft flag
  repo                optional   "workspace/repo" slug
  number              optional   PR number within the repo
  change_type         optional   "feat"|"fix"|"refactor"|"docs"|"chore"|"perf"
                                 |"test"|"build"|"ci"|"revert"
  breaking            optional   boolean — breaking-change callout
  risk                optional   "low" | "medium" | "high"
  base_ref            optional   target branch (e.g. "main")
  head_ref            optional   source branch
  merge_commit_sha    optional   sha of the merge commit (when merged)
  stats               optional   { additions, deletions, changed_files, commits }
  labels              optional   ["area:auth", "needs-review", ...]
  ci_status           optional   "passing" | "failing" | "pending"
  opened_at           optional   ISO 8601 UTC
  merged_at           optional   ISO 8601 UTC
  closed_at           optional   ISO 8601 UTC
  author_principal_id optional   principal who opened it; auth/import fills
  reviewers_principal_ids optional ["principal_01...", ...]
  merged_by_principal_id  optional principal who merged it
  -- connections — each is an authored field the capture path projects into a
  -- first-class edge (origin='field'); none is stored as an FK column on the
  -- node. See graph-authoring-contract. --
  implements          optional   ["action_01...","state_01...","decision_01..."]
                                 nodes this PR implements (writes implemented_by edge)
  fixes               optional   ["log_01...","reference_01...", ...] bugs/incidents fixed (writes fixed_by edge)
  intent_ids          optional   ["intent_01...", ...]   (writes serves edge)
  decision_ids        optional   ["decision_01...", ...] (writes enacts edge)
  gated_by            optional   ["rule_01...", ...]      (writes gated_by edge — rules that gated it)
  relates_to          optional   ["pull_request_01...","reference_01...", ...] (writes relates_to edge)
  born_from           optional   id this PR was born from, e.g. an incident log (writes born_from edge)
  lifecycle           optional   "drafting" | "asserted" | "retired"; usually derived from state
  superseded_by       optional   id of the PR/decision that replaces this one
                                 (writes superseded_by edge; cardinality one)

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "pull_request_<ULID>",
    "path": "docos/<doco-handle>/pull_requests/pull_request_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Pull Request added: [<title>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE
  curl -sS -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $DOCO_ACCESS" \
    ${baseUrl}/${handle}/api/pull_requests.json \
    -d '{
      "title": "fix(checkout): retry idempotency key on 409",
      "pull_request": "The checkout BPM event double-charged on retry. This makes the key idempotent and adds a guard rule.",
      "locator": "https://github.com/acme/store/pull/482",
      "repo": "acme/store", "number": 482,
      "state": "merged", "change_type": "fix", "risk": "high",
      "merged_at": "2026-05-30T18:04:11Z",
      "author_principal_id": "principal_01...",
      "implements": ["action_01CHECKOUTCHARGE..."],
      "fixes": ["log_01DOUBLECHARGE..."],
      "decision_ids": ["decision_01IDEMPOTENTKEYS..."],
      "gated_by": ["rule_01NORETRYWITHOUTKEY..."]
    }'

UPDATE AN EXISTING PULL REQUEST
  PATCH ${baseUrl}/${handle}/api/pull_requests/<id>.json
  (or re-POST the same locator — upsert)
  Content-Type: application/json

  All fields optional; only keys you include are touched. Typical re-sync:
  state, draft, merge_commit_sha, merged_at/closed_at, ci_status, stats,
  labels, reviewers_principal_ids, and additive links via
  implements_add / fixes_add / intent_ids_add / decision_ids_add.
  Response is the capture shape plus `changed: string[]`.

RELATED
  GET ${baseUrl}/${handle}/status.json   freshness + counts (footer)
  GET ${baseUrl}/api/v1/agent-bootstrap.json    canonical instructions
```

---

## 5. Worked example — the search/connect payoff

A merged bug-fix PR, captured once, becomes a hub the whole team can query:

```
pull_request_01…  "fix(checkout): retry idempotency key on 409"  [merged]
   ├─ implements  → action_01…  "Charge card"        (BPM event in the checkout flow)
   ├─ fixes       → log_01…     "Double charge on network retry"  (the bug)
   ├─ enacts      → decision_01… "Idempotency keys on all mutating calls"
   └─ gated_by    → rule_01…    "No retry without an idempotency key"  (rule born from the fix)
```

Now answerable in one search: *"what shipped the Charge-card event"*, *"what
fixed the double-charge"*, *"which PRs enact the idempotency decision"*, and —
because `implements` writes the canonical `implemented_by` edge — the BPM event
itself shows the PR that implemented it.

---

## 6. GitHub auto-import & ongoing sync

### 6.1 Idempotency — why the node must be mutable
Natural key = the canonical PR URL (`locator`), equivalently `(repo, number)`.
Every import is an **upsert**: first sight POSTs, later sightings PATCH the same
node. This is the core reason for a dedicated, upsert-friendly type over the
Reference snapshot/supersede contract — re-syncing a PR's `open → merged`
transition must not mint a new node each time.

### 6.2 Field mapping (GitHub → Doco)

| GitHub `pull_request` payload | Doco field |
|---|---|
| `title` | `title` |
| `body` | `pull_request` (prose) + parse links (§6.3) |
| `html_url` | `locator` |
| `base.repo.full_name`, `number` | `repo`, `number` |
| `state` + `merged` + `draft` | `state`, `draft` → derived `lifecycle`/`outcome` |
| `merge_commit_sha` | `merge_commit_sha` |
| `base.ref`, `head.ref` | `base_ref`, `head_ref` |
| `user.login` | `author_principal_id` (via stored GitHubIdentity) |
| `requested_reviewers[]`, reviews | `reviewers_principal_ids` |
| `merged_by.login` | `merged_by_principal_id` |
| `labels[].name` | `labels` |
| `additions`, `deletions`, `changed_files`, `commits` | `stats` |
| `created_at`, `merged_at`, `closed_at` | `opened_at`, `merged_at`, `closed_at` |
| check-runs / status | `ci_status` |

**Principal mapping** reuses the existing `GitHubIdentity`
(`github_id` / `github_login` already stored on users). Unknown contributors
either get a lightweight external Principal or leave `author_principal_id`
unset. **Provenance stays clean:** `created_by` = the import API key;
`author_principal_id` = the human — the spec already separates these.

### 6.3 Link inference — turn prose into edges
Two signals, parsed from title/body/branch:

1. **GitHub closing keywords** — `Closes/Fixes/Resolves #N` → a linked-issue
   `reference` (or `fixes` when the issue is a tracked bug).
2. **Doco trailers** (the high-value bit) — machine-readable lines a human (or
   an agent) drops in the PR description:
   ```
   Doco-Implements: action_01CHECKOUTCHARGE…
   Doco-Fixes: log_01DOUBLECHARGE…
   Doco-Enacts: decision_01IDEMPOTENTKEYS…
   Doco-Serves: intent_01RELIABLECHECKOUT…
   ```
   The importer reads these straight into `implements` / `fixes` /
   `decision_ids` / `intent_ids`. This is what lets a PR "point to the BPM
   event it implements" automatically — wired at description-write time, synced
   on import. The recommended `PULL_REQUEST_TEMPLATE.md` (§7) ships these
   trailers pre-stubbed.

### 6.4 Backfill historical PRs
Page `GET /repos/{workspace}/{repo}/pulls?state=all&per_page=100` oldest-first;
upsert each by `locator`. Safe to re-run (idempotent). Respect rate limits;
store a cursor (`updated_at` high-water mark) for incremental catch-up.

### 6.5 Ongoing live sync (new infrastructure)
Add an **inbound** webhook route (the repo has outbound webhook patterns for
health alerts — `DOCO_HEALTH_WEBHOOK_URL` — but nothing inbound for GitHub).
Subscribe to `pull_request` events (`opened`, `edited`, `closed`, merged via
`closed`+`merged:true`, `synchronize`, `ready_for_review`, `labeled`,
`review_requested`) and `pull_request_review`. Verify
`X-Hub-Signature-256` (HMAC) before processing; each event upserts by
`locator`. A GitHub App (per-repo install) is the clean auth model; a webhook +
PAT is the minimal one.

---

## 7. Recommended `.github/PULL_REQUEST_TEMPLATE.md`

Closes the loop between the two senses of "template": the GitHub-side
description template produces exactly the structured info the Doco-side node
template ingests. **Proposed, not activated** here — turning it on changes every
contributor's PR UX, which is the team's call (§9).

```markdown
## What & why
<!-- Summary + the motivation the diff can't show. -->

## Type of change
<!-- feat | fix | refactor | docs | chore | perf | test | build | ci | revert -->
- [ ] Breaking change

## How tested
<!-- Test plan / repro steps / screenshots for UI. -->

## Risk & rollback
<!-- low | medium | high — and how to roll back. -->

## Doco links
<!-- Machine-readable; the importer reads these into the PR node. -->
Doco-Implements:
Doco-Fixes:
Doco-Enacts:
Doco-Serves:

Closes #
```

---

## 8. Phased rollout

- **Phase 0 — interim (no new type):** add `ref_type: "pull_request"` to the
  `reference` enum and start writing `implements`/`fixes` edges from existing
  nodes. Ships value immediately; forward-compatible with Phase 1.
- **Phase 1 — the node type:** register `pull_request` in `NODE_TYPE_META`
  (`segment: "pull_requests"`, `proseField: "pull_request"`), add the
  `PullRequest` interface to `entities.ts`, the capture function, the spec text
  (§4), an icon, and the two relation kinds (`implements`/`implemented_by`
  pairing, `fixes`/`fixed_by`). Manual + API capture only.
- **Phase 2 — GitHub backfill:** the import mapper (§6.2–6.3) + a one-shot
  backfill command over `pulls?state=all`.
- **Phase 3 — live sync:** the inbound webhook route (§6.5) with signature
  verification and a GitHub App.

**Implementation touch-points (Phase 1):** `packages/shared/src/entities.ts`,
`packages/web/app/lib/node-types.ts`,
`packages/web/app/lib/graph-authoring-contract.server.ts`, the capture-factory
and per-type route, `packages/db/src/schema.sql`, and the spec route. **TDD:**
each is a behavior change — write the red test first (capture validation,
lifecycle mapping, `implements`→`implemented_by` projection, importer
idempotency by `locator`, trailer parsing) per `AGENTS.md`, and gate on
`pnpm verify`.

---

## 9. Open questions (owner's call)

1. **Dedicated `pull_request` type vs. enriched `reference`?** Proposal
   recommends the dedicated type (with Reference as the Phase-0 on-ramp).
2. **Merged-PR lifecycle:** `asserted` (visible live fact, proposed) vs.
   `retired` (consistent with completed `action`s)?
3. **How is a "bug" modeled in this Doco** — `log`, `intent`, `state`, or
   external-issue `reference`? Determines what `fixes` points at by default.
4. **Activate `.github/PULL_REQUEST_TEMPLATE.md` repo-wide now,** or keep it as
   a recommendation until the importer exists?
5. **ID prefix:** full `pull_request_<ULID>` (consistent with `reference_`,
   `principal_`) vs. short `pr_<ULID>`?
6. **Auth model for sync:** GitHub App (recommended) vs. webhook + PAT?
7. **Prerequisite:** the `doco-bpms` connection 404s today — repoint
   `.doco/connections.md` / re-mint the project token before dogfooding.
