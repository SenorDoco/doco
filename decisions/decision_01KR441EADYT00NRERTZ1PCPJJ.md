---
id: decision_01KR441EADYT00NRERTZ1PCPJJ
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Use better-sqlite3 (synchronous, native binding) over node:sqlite (Node 22 builtin) for the index — battle-tested + prebuilds available."

slug: sqlite-binding-is-better-sqlite3
number: "ADR-059"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "Which SQLite binding does the index package use?"
chosen: |
  `better-sqlite3` v11+. Synchronous API (cheap with WAL mode), native
  binding with prebuilds for Apple Silicon / x86 / musl Linux, ships FTS5
  and recursive CTE support out of the box, and has a large user base.
alternatives:
  - name: node:sqlite (Node 22 built-in)
    rejected_because: "Newer; less battle-tested; FTS5 support depends on the build of the bundled SQLite. Reverse-signal swap target named in ADR-046."
  - name: sqlite3 (async)
    rejected_because: "Async-only API forces every query to await. better-sqlite3's sync model is faster for our workload."
rules_consulted:
  - rule_01KR441EAF7M5QPF65BXGD1ET1
decided_by: torrenegra
decided_at: 2026-05-08T16:00:00Z

created_at: 2026-05-08T16:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-059 — Index binding = better-sqlite3

Whitelisted in `package.json`'s `pnpm.onlyBuiltDependencies` so the native
prebuild downloads on `pnpm install`. If the prebuild matrix gets gappy on
some platform (e.g., new musl Linux variant), swap to `node:sqlite` — same
SQL, smaller dep surface, but probably slower.
