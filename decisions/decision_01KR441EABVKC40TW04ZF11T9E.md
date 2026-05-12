---
id: decision_01KR441EABVKC40TW04ZF11T9E
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "GitHub OAuth deferred to Phase 6; Phase 4 ships a local-dev auth flow using `doco serve --as-principal <id>` and a file-backed token store."

slug: github-oauth-deferred-local-dev-auth
number: "ADR-057"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT
question: "How does Phase 4 handle authentication when phases 1-5 are localhost-only and GitHub OAuth requires app registration + secrets?"
chosen: |
  Phase 4 ships the auth scaffolding (TokenStore, auth middleware, parseBearer)
  but defers the GitHub OAuth handshake to Phase 6 (deployment). For local
  dev:
    - `doco serve --as-principal <principal_id>` accepts unauthenticated
      requests as that principal (trusted-localhost mode).
    - `doco serve --require-token` enforces Bearer auth using session tokens
      issued via TokenStore.issueSessionToken (admin-only for now).
    - Session tokens stored at `.doco/tokens.json` (per ADR-058).
  Production (Phase 6) flips on require-token and registers a GitHub OAuth app.
alternatives:
  - name: Implement GitHub OAuth in Phase 4
    rejected_because: "Requires real client_id/secret + a public callback URL — incompatible with localhost-only scope per founder direction."
  - name: Implement passwordless / magic-link auth for local
    rejected_because: "Conflicts with ADR-034 (humans sign in only via GitHub). Local trust mode keeps the spec clean."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T16:00:00Z

created_at: 2026-05-08T16:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-057 — GitHub OAuth deferred; local-dev auth is `--as-principal`

Reference: PLANNING.md §3, ADR-034. The GitHub OAuth flow lands in Phase 6
when `doco.to` is deployed and an OAuth app can be registered against a
public callback URL.
