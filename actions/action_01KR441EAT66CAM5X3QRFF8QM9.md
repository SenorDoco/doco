---
id: action_01KR441EAT66CAM5X3QRFF8QM9
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Migrated web layer from Hono+JSX SSR to Remix v7 + Tailwind v4 + shadcn-style components per ADR-055; verified via Chrome MCP."

actor_id: claude-opus-4-7
verb: migrate_web_stack
target: intent_01KR441EAEM5NQBM160763TDDT

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR441EA9PY9B1V5H7JRN8DAV   # ADR-055 web migration
  - decision_01KR441EA09QKWEH0J9ZY1XFBB   # ADR-046 tech stack (Remix specified there)

inputs:
  before: "Hono + JSX SSR"
  after: "React Router v7 framework mode + Tailwind v4 + hand-rolled shadcn-style primitives"
  packages_changed: [web, cli]

outputs:
  files_replaced: ["packages/web/src/* → packages/web/app/*"]
  routes: ["/", "/e/:type", "/e/:type/:id", "/search", "/lint"]
  cli_change: "doco serve no longer mounts web; runs API only on :8787; web is `pnpm --filter @doco/web dev` on :5173"
  e2e_verification: "Chrome MCP navigated all 5 routes; getComputedStyle confirmed Tailwind tokens applied"
  production_build_verified: true
  commits: [fa8bbb6, d0fbef4]

started_at: 2026-05-08T17:50:00Z
ended_at: 2026-05-08T17:58:00Z

created_at: 2026-05-08T17:58:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Migrate web to Remix v7 / Tailwind v4 / shadcn-style

Reasoning for this migration is captured separately in
[reasoning_01KR441EAWX4G32ZJGF8NH4T83](../reasoning/reasoning_01KR441EAWX4G32ZJGF8NH4T83.md).

Material added: app/root.tsx, app/routes.ts, 5 route files, app/lib/{db,cn}.ts,
app/components/{badge,card,table,site-header}.tsx, app/app.css with
Tailwind v4 + @theme tokens, vite.config.ts with reactRouter() +
tailwindcss() plugins, react-router.config.ts.

Material removed: packages/web/src/{server.tsx, layout.tsx, index.ts}.
