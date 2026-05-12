---
id: decision_01KR441EBSMYJB6YMTGCRKTVZS
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Token revocation cascades strictly by default. Per-Doco override flag for 'scoped' mode (only revoke the named token)."

slug: token-revocation-cascades-strictly
number: "ADR-038"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "When a session token is revoked, what happens to agents whose ancestry chain passes through it?"
chosen: |
  Strict cascade: revoking a session token invalidates all session tokens
  whose ancestry chain passes through it. Per-Doco override flag for
  "scoped" mode (only revoke the named token).
alternatives:
  - name: Scoped-only (no cascade)
    rejected_because: "Less safe for security incidents — a compromised human's downstream agents remain authorized."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T15:18:00Z
superseded_by: decision_01KREMDWG6SWKFHR5P1RDB64NC

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: superseded
status: superseded
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-038 — Token revocation cascades strictly (default)

Open: per-Doco override semantics, persistence, audit trail not yet
specified (DECISIONS.md §13 #6).

Reference: PLANNING.md §3.3, §6.
