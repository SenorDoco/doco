---
id: decision_01KR441EA9PY9B1V5H7JRN8DAV
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Web layer migrated to Remix v7 (React Router 7) + Tailwind v4 + shadcn-style components, executing ADR-046 after a brief Hono+JSX SSR deviation."

slug: web-migration-to-remix
number: "ADR-055"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "How is the web layer implemented, given ADR-046 specifies Remix/Tailwind/shadcn but Phase 5 initially shipped Hono+JSX SSR for time?"
chosen: |
  Migrate to the originally-specced stack: React Router v7 (framework mode)
  with file-config routes, Tailwind v4 (config-less, @import "tailwindcss"),
  and hand-rolled shadcn-style primitives (Badge / Card / Table / SiteHeader)
  using cva + clsx + tailwind-merge. SQLite is read directly in loaders;
  better-sqlite3 is marked external in vite.config.ts; workspace deps are
  noExternal so the SSR bundle pulls them in.

  doco serve no longer mounts web — runs API only on :8787. Web runs as
  its own dev server: `pnpm --filter @doco/web dev` on :5173.
alternatives:
  - name: Keep Hono+JSX SSR (don't migrate)
    rejected_because: "Deviates from ADR-046 (which names Remix). Founder explicitly redirected to migrate."
  - name: Use Remix in non-framework (library) mode embedded in Hono
    rejected_because: "Loses Remix's HMR + nested routing convenience. Two-process dev is acceptable for v0 localhost."
rules_consulted:
  - rule_01KR441EAF7M5QPF65BXGD1ET1   # priority-order
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T17:00:00Z

created_at: 2026-05-08T17:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-055 — Web migration to Remix v7 / Tailwind v4 / shadcn-style

Re-confirms ADR-046's web stack choice and supersedes the brief Hono+JSX
SSR implementation that shipped on 2026-05-08T17:00 to compress phase 5
delivery. The Hono+JSX implementation was reverted; nothing references it
anymore.

Verified live via Chrome MCP across all 5 routes (/, /e/:type, /e/:type/:id,
/search, /lint). Production build (`react-router build`) also clean.
