---
id: decision_01KR441EAC4VGX4QM3NFDEK1MW
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "TokenStore is a JSON file at `.doco/tokens.json` for self-hosted Docos in Phase 4; SaaS gets a managed encrypted DB in Phase 6 behind the same interface."

slug: token-store-local-json-for-v0
number: "ADR-058"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "Where do session tokens live in self-hosted Docos before Phase 6 wires up a managed DB?"
chosen: |
  Local JSON file at `.doco/tokens.json` (ignored by git per the existing
  `.doco/` gitignore rule). Implements TokenStore.{load, save, issueSessionToken,
  resolve, revoke(cascade=true per ADR-038)}. The file IS the source of truth
  for self-hosted; SaaS swaps to Postgres/Neon/Supabase behind the same
  interface in Phase 6.

  `.doco/tokens.json` is NOT committed to git per ADR-039 (tokens stored
  externally to the Doco's source tree).
alternatives:
  - name: Embedded SQLite for tokens
    rejected_because: "Adds a write-mode db handle; JSON is sufficient at v0 scale (handful of tokens per Doco)."
  - name: Postgres from day one
    rejected_because: "Requires a server. Self-hosted Docos should run with zero infra dependencies."
rules_consulted:
  - rule_01KR441EAK6MKGDZZWH5TRZ9HQ   # no-secrets-in-doco
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

# ADR-058 — TokenStore = local JSON for v0 self-hosted

Implementation: [@doco/api auth.ts](../packages/api/src/auth.ts).
Strict revocation cascade per ADR-038 implemented inline (BFS over
invited_by chain).

Phase 6 swaps the file backend for Postgres-on-Neon (or similar) while
keeping the same async TokenStore interface. The cascade logic is identical;
only the storage call sites change.
