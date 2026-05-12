---
id: decision_01KR441EBNZJTAW29W7YM38K30
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Humans sign in to Doco exclusively via GitHub OAuth. No email/password, no magic links."

slug: humans-sign-in-via-github-only
number: "ADR-034"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "How do humans authenticate to Doco?"
chosen: |
  GitHub OAuth is the only sign-in for humans. No email/password, no magic
  links. A human's `Principal.username` is their GitHub login.
alternatives:
  - name: OIDC / SAML
    rejected_because: "Adds complexity for v0.x. Open question DECISIONS.md §13 #7 — revisit when adoption signal demands broader support. Every alternative provider must still resolve to a verified external identity (no Doco-native passwords)."
  - name: Email + password
    rejected_because: "Extra surface area to secure (password resets, email verification). Avoidable in v0."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-034 — Humans sign in exclusively via GitHub

Universal among target users (developers, AI-tool teams). Locks identity to
a verified external authority. Aligns with the git-repo mental model.

Reference: PLANNING.md §2.1.
