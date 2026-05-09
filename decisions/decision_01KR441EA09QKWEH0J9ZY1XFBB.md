---
id: decision_01KR441EA09QKWEH0J9ZY1XFBB
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Implementation in TypeScript on Node 22 LTS; pnpm workspaces monorepo; Bun for compiled CLI; Hono API; Remix web; better-sqlite3 index; vitest tests."

slug: tech-stack-typescript-monorepo
number: "ADR-046"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "What language and stack do we use to implement Evalo?"
chosen: |
  TypeScript on Node 22 LTS. pnpm workspaces monorepo. Bun for compiled-binary
  CLI distribution. vitest for tests. Hono for the API. Remix (React Router 7)
  for the web app. better-sqlite3 (sync) for the index. citty for the CLI
  framework. shadcn/ui + Tailwind v4 for web UI. Lucia for sessions.
alternatives:
  - name: Python
    rejected_because: "Strongest for embeddings + importers but loses single-language coherence across CLI/API/web. Two ecosystems = double the agent context-switch."
  - name: Rust
    rejected_because: "Single-binary distribution is great, iteration speed too slow for a v0 framework still in design flux."
  - name: Go
    rejected_because: "Excellent CLI ergonomics, OK API, weak for the rich web app needed in phase 5."
rules_consulted:
  - rule_01KR441EAF7M5QPF65BXGD1ET1   # priority-order
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T16:30:00Z

created_at: 2026-05-08T16:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-046 — Tech stack: TypeScript / pnpm monorepo

## Initial monorepo packages

```
packages/
  shared/      # types, ULID gen, time helpers, schema constants
  core/        # source-of-truth: read/write/validate entity files
  index/       # SQLite + FTS5 cache, edges adjacency, scope_match
  runtime/     # predicate evaluator + check engine
  lints/       # 4 system lints
  cli/         # `evalo` command — phase 1+
  api/         # Hono REST API — phase 4
  web/         # Remix web app — phase 5
  discovery/   # embeddings + glossary expansion — phase 5
```

## Reverse signal

If `better-sqlite3` proves problematic on Apple Silicon or musl Linux, swap
to `node:sqlite` (Node 22 builtin) — same query surface.
