---
id: decision_01KR6QZCH0RSDB22YC5H6M4BKZ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Add `idea` as the 12th node type. Captures speculative thoughts before they crystallize into Intent / Decision / Action. Lightweight: summary + body + proposer + optional promoted_to. Supersedes ADR-009's 'final' 11-type list."

slug: idea-as-twelfth-node-type
number: "ADR-074"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "ADR-009 fixed the data model at 11 node types and called it 'final'. In practice we found 'speculative thoughts' didn't fit any of them — proposed Intent felt too crystallized, proposed Decision had alternatives but assumed a choice was being made, proposed Action presumed a task. The user picked 'C' from a brainstorm of three options. What does the new type look like?"
chosen: |
  A new node type `idea` with deliberately minimal structure:

  | Field | Required | Notes |
  |---|---|---|
  | `summary` | yes (common) | The gist, ≤240 chars |
  | `body` | no | Free-form elaboration |
  | `proposer_id` | no | Principal who originated it; defaults to `created_by` |
  | `promoted_to` | no | Set when the idea becomes an Intent/Decision/Action |
  | `rejection_reason` | no | Set when the idea is abandoned |

  Lifecycle reuses the existing enum:
  - `proposed` (default) — fresh idea, not yet acted on
  - `succeeded` — promoted (set `promoted_to`)
  - `abandoned` — rejected (set `rejection_reason`)
  - `superseded` — absorbed by another idea or work

  Files live at `ideas/idea_<ULID>.md` (Markdown with frontmatter, same
  shape as Intent/Decision/Action).

  This supersedes [ADR-009](./decision_01KR441EAWNQ4ZAPG0XGA9RJZX.md)'s
  "final" 11-type assertion. ADR-009 stays as historical record;
  ADR-074 is the new canonical list.

  ## Why a new type, not just `proposed Intent`

  Ideas and Intents differ in kind, not just lifecycle:

  - **Idea**: "What if we did X?" — speculative, low commitment, may
    be discarded without ceremony.
  - **Intent**: "We want X." — directed, has acceptance criteria,
    expects to be satisfied.

  Squeezing the former into the latter pollutes the Intent surface
  (the entire intents/ directory becomes 50% wishful thinking) and
  loses the explicit promotion arrow that documents which ideas
  graduated.
alternatives:
  - name: A. Use existing types with lifecycle:proposed
    rejected_because: "User picked C. Existing types work but blur the line between speculative and directed work; the promotion arrow gets lost."
  - name: B. Just add a tag_idea
    rejected_because: "User picked C. The tag handles cross-cutting filtering but doesn't give ideas their own lifecycle or promotion field."
  - name: D. Add `idea` field on Intent (a flag)
    rejected_because: "Not on the table during the brainstorm but worth recording: would force ideas to fit Intent's required fields (title, acceptance) which defeats the lightweight intent."

rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-09T16:00:00Z

created_at: 2026-05-09T16:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-074 — Idea as the 12th node type

## Origin

The companion idea entity
([idea_01KR6QZCHKRJH1YH2V6EXQ7S9H](../ideas/idea_01KR6QZCHKRJH1YH2V6EXQ7S9H.md))
captures the moment of self-promotion: the very first idea is the
proposal to add ideas as a type, then it gets promoted to this
Decision. Future ideas follow the same arc.

## Schema delta

- `schema/doco.schema.json`:
  - `id` regex extended to allow `idea_<ULID>`.
  - `namespaced_id` regex same.
  - `idea_entity` definition added with optional fields.
  - `oneOf` list updated.
- `packages/shared/src/branded.ts`: `idea` added to `NODE_TYPES`.
- `packages/shared/src/entities.ts`: `Idea` interface; added to `Entity`
  union.
- `packages/core/src/paths.ts`: `idea` mapped to `ideas/` dir, `md` format.
- `packages/index/src/migrate.ts`: `CREATE TABLE idea` with the four
  optional columns.
- `packages/index/src/insert.ts`: `case "idea"` branch.
- API server's `countByType` + `isKnownType` lists.
- Web `KNOWN` sets in 4 routes; site nav adds `Ideas` tab.

## What this means for ADR-009

ADR-009 said the 11-type list was "final" — meaning we'd resist adding
types unless the gap was real. Two years of self-hosting later (well,
two days), we found the gap. ADR-074 supersedes ADR-009's count; the
selection criterion in ADR-009 ("a node type earns its place by
distinctly carrying meaning that no other type carries") still
applies.

## Pre-v1 schema bump

Per ADR-050, schema major version bumps require migration tooling.
This change is *additive*: existing entities don't change shape, no
migration is needed for old data, no version bump required while
schema_version remains `0.1`. When v1.0 is approached, the schema
version freezes; until then, additive changes ship freely.
