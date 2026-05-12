---
id: reasoning_01KR441EAWX4G32ZJGF8NH4T83
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: reasoning
schema_version: "0.1"
summary: "Premises (ADR-046 names Remix; Phase 5 shipped Hono+JSX for time; founder explicitly redirected) → conclusion (migrate web to Remix v7 + Tailwind v4 + shadcn-style)."

author_id: claude-opus-4-7

premises:
  - node_type: decision
    ref: decision_01KR441EA09QKWEH0J9ZY1XFBB
    as: "ADR-046 selects Remix + Tailwind v4 + shadcn for the web layer."
  - node_type: action
    ref: action_01KR441EAS9RJG4GCVF2VXFKDJ
    as: "Phase 5 initially shipped Hono+JSX SSR — a deviation from ADR-046 to compress delivery time."
  - node_type: intent
    ref: intent_01KR441EAEM5NQBM160763TDDT
    as: "Implementation-v0 intent's acceptance includes the web app per the spec; the deviation was tolerated only as a stopgap."

inference: |
  Two valid interpretations of the Phase 5 deviation existed: (a) accept the
  Hono+JSX SSR as good-enough since it satisfied the visual demo, or (b)
  honor ADR-046 by migrating before considering Phase 5 complete. The founder
  explicitly chose (b) ("Do this right away: Migration to Remix/Tailwind/shadcn"),
  which dissolves the ambiguity. The migration is the action that aligns
  Phase 5's delivery with Phase 5's specced design.

  Mechanically, the migration is mostly a rewrite of `packages/web/src/server.tsx`
  (~370 lines of Hono JSX) into Remix conventions (root.tsx + 5 routes +
  components). Data layer (@doco/discovery, @doco/index, @doco/lints)
  is unchanged — loaders read the same SQLite db. CLI's `doco serve` drops
  web mounting; web becomes its own dev server on :5173.

conclusion_ref: action_01KR441EAT66CAM5X3QRFF8QM9
confidence: 0.95
uncertainty:
  - "Whether the migration should have happened DURING phase 5 (preventing the deviation) or AFTER (as it did). The retro-fit is more disruptive but reflects honest time-pressure management; the founder accepted it."
  - "Whether the hand-rolled shadcn-style primitives (Badge/Card/Table/SiteHeader) should be replaced with `npx shadcn@latest add ...` formal copies. Equivalent visually; a follow-up Decision can settle convention."

created_at: 2026-05-08T17:58:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: active
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Reasoning for the Remix migration

Captured retroactively as part of the
[backfill action](../actions/action_01KR441EAVAACD014TK7XH49WK.md).
The reasoning was implicit in the conversation when the founder redirected;
this entity makes it queryable for future contributors and surfaces the
two `uncertainty[]` items for review.
