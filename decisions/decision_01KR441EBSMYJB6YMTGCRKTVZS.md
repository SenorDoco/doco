---
id: decision_01KR441EBSMYJB6YMTGCRKTVZS
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Token revocation cascades strictly by default. Per-Evalo override flag for 'scoped' mode (only revoke the named token)."

slug: token-revocation-cascades-strictly
number: "ADR-038"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "When a session token is revoked, what happens to agents whose ancestry chain passes through it?"
chosen: |
  Strict cascade: revoking a session token invalidates all session tokens
  whose ancestry chain passes through it. Per-Evalo override flag for
  "scoped" mode (only revoke the named token).
alternatives:
  - name: Scoped-only (no cascade)
    rejected_because: "Less safe for security incidents — a compromised human's downstream agents remain authorized."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-038 — Token revocation cascades strictly (default)

Open: per-Evalo override semantics, persistence, audit trail not yet
specified (DECISIONS.md §13 #6).

Reference: PLANNING.md §3.3, §6.
