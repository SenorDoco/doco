---
id: action_01KR6SND6D2WBY1619QT6GJFSG
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 12 — visible brand rename Doco → Doco. Page titles, headings, hero, wordmark, AGENT.md, CLAUDE.md, helper text. Tagline added: 'AI-native documentation of important ideas, decisions, and rules.'"

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: rename_visible_brand_doco_to_doco

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EAQ1J516HMAMZ66NKRJ   # ADR-004 (entity ID prefixes — context for what's NOT renamed yet)
  - decision_01KR441EA4F19H61WSEDAYAHVH   # ADR-050 (schema versioning — explains why technical rename is bigger)

inputs:
  user_direction: |
    "Let's rename Doco into Doco. The tagline of Doco is 'AI-native
    documentation of important ideas, decisions, and rules.'"
  scope: "Visible brand only. Page titles, headings, prose, wordmark, doc files. Technical surface (TS identifiers, schema, package names, env vars, .doco/, doco.yaml, doco_<ulid> ids, cookie name) intentionally stays 'doco' — not on the roadmap to rename."

outputs:
  source_files_changed:
    - packages/web/app/components/doco-mark.tsx           # rendered "Doco" wordmark; comment updated; aria-label "Doco"
    - packages/web/app/components/site-header.tsx          # nav labels Docos→Docos, "+ Doco"→"+ Doco", aria "Doco home"
    - packages/web/app/root.tsx                            # default title "Doco"
    - packages/web/app/routes/_index.tsx                   # all page titles + hero + dashboard text + tagline
    - packages/web/app/routes/*.tsx (sweep)                # ~25 files: "X · Doco" → "X · Doco" + brand-text "Doco" → "Doco"
    - packages/web/app/lib/*.ts (sweep)                    # comments + error messages
    - AGENT.md                                             # tagline; brand mentions; data-model table label kept lowercase
    - CLAUDE.md                                            # one-liner pointer
    - actions/action_01KR441EACS9CF3JXJBGJV019P.md         # Aligno rename → superseded_by Doco rename
    - actions/action_01KR6G9454VZM160S7HHZWBVBY.md         # Aligno brand assets → abandoned (brand pivoted)
  what_was_NOT_renamed:
    - "TS identifiers: DocoMark, listAllDocos, loadDoco, openDocoDb, getDocoSlug, SingleDocoRecent, etc."
    - "Schema id pattern, namespaced_id, idea_entity (still uses 'doco_id' field name etc.)"
    - "Package names: @doco/* unchanged"
    - "CLI binary: still 'doco'"
    - "Env vars: DOCO_TOKEN, DOCO_HOST, DOCO_ROOT, DOCO_PUBLIC_HOST"
    - ".doco/cache.db, .doco/tokens.json directory layout"
    - "Cookie name doco_session"
    - "Reserved-slug list (still includes 'doco')"
    - "doco.yaml at the root of every Doco (now Doco)"
    - "node_type: 'doco' constant"
    - "All entity ids: doco_<ulid>, doco_id field on every entity"
    - "All historical Decisions/Actions/Reasoning text (those Decisions stay as written; the project is named Doco going forward, but the historical record uses 'Doco')"
  tagline_placements:
    - "packages/web/app/routes/_index.tsx (anonymous home, under wordmark)"
    - "AGENT.md introduction"

started_at: 2026-05-09T16:30:00Z
ended_at: 2026-05-09T16:45:00Z

created_at: 2026-05-09T16:45:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 12 — Visible brand rename: Doco → Doco

The user picked "Doco" as the project's name and provided a new tagline.
This Action ships the **visible** rename: anything a user sees in the
web UI, in AGENT.md/CLAUDE.md, in pasted share messages. The deep
technical rename (schema, package names, env vars, etc.) is captured
as a separate planned Action.

## What's visible now

- Wordmark renders "Doco" in the brand olive (#707A23) Ubuntu Mono Bold,
  next to the existing favicon icon.
- Page titles: "X · Doco" everywhere.
- Hero on signed-out home page: tagline shown beneath the wordmark.
- Site nav: "Docos" tab in host mode; "+ Doco" button to create.
- AGENT.md introduction uses the tagline.
- All "Doco" prose mentions (in JSX, in comments visible to readers,
  in error messages) replaced with "Doco".

## What stays "doco" (permanently)

The technical surface — TS identifiers, schema field names, package
names, CLI binary, env vars, the `.doco/` cache directory, the
`doco.yaml` root file, the `doco_<ulid>` entity ID prefix, cookie
name — is **not on the roadmap to rename**. Originally a Phase B
follow-up to this Action; subsequently dropped at the founder's
direction. The cost of a clean technical rename (migration tool,
schema major bump, every entity file rewritten, all packages renamed)
isn't worth the cognitive cleanliness when the visible brand already
reads "Doco" everywhere a user looks.

The previously-planned Aligno rename
([action_01KR441EACS9CF3JXJBGJV019P](action_01KR441EACS9CF3JXJBGJV019P.md))
and Aligno brand-assets backlog
([action_01KR6G9454VZM160S7HHZWBVBY](action_01KR6G9454VZM160S7HHZWBVBY.md))
are both marked abandoned (brand pivoted from Aligno to Doco; Aligno
SVGs no longer the target).

## Why visible-only

Renaming the user-facing brand is zero-risk and ships in one turn —
anyone hitting the web sees "Doco" immediately. Renaming the
*technical* surface (every entity file, package name, env var, cache
directory, cookie) would require a migration tool, a schema major
bump per ADR-050, and a high-blast-radius coordinated change. The
founder dropped that work after this turn — it's not on the roadmap.

The split has a real cost: the user reads "Doco" but the data files
and code identifiers stay "doco_..." indefinitely. That dissonance
is acceptable as long as the two surfaces stay clearly separated:
brand for users, doco for the implementation.

## Historical record

Every existing Decision, Action, Reasoning written before this Action
references "Doco" in its prose. Those stay as written — the project
*was* Doco at the time of authorship; it *is* Doco now. The structured
fields (id, doco_id, node_type) also stay "doco_...". Permanent
state, not a transient migration window.

## Tagline

> AI-native documentation of important ideas, decisions, and rules.

Where it lives:
- Anonymous home page, beneath the wordmark.
- AGENT.md introduction.
- (Future: meta description tag on page heads, marketing copy.)
