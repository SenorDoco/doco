---
id: rule_01KR441EAK6MKGDZZWH5TRZ9HQ
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: rule
schema_version: "0.1"
summary: "No secrets (tokens, keys, credentials) may be committed to an Evalo's git tree."

born_from: decision_01KR441EBTZDSJC0PEDTX4QHNE   # ADR-039 (tokens stored externally)
slug: no-secrets-in-evalo
modality: must_not
severity: blocker
phase: pre
applies_to:
  node_type: action
  verb: commit
predicate: |
  No file in the commit may contain a string matching the secret-pattern set
  (private keys, tokens, API keys, EVALO_TOKEN values, GitHub PATs, etc.).
expected: true
on_violation: block

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: active
tags: []
---

# No secrets in the Evalo

Token *values* live in the API server's encrypted database (D-039). The Evalo
records *which* Principals exist and the lineage; the index reflects edges.
Token values must never be committed to git.

This Rule is the runtime check at `commit` time. The predicate scans staged
content for known secret patterns (matching common formats: `ghp_*`, `sk-*`,
`-----BEGIN ... PRIVATE KEY-----`, `EVALO_TOKEN=...`, etc.) and blocks the
Action if any match.

For the Evalo itself (this repository), the same rule applies: no GitHub
tokens, no Anthropic keys, no anything. Memory files at
`/Users/torrenegra/.claude/projects/-Users-torrenegra-Evalo/memory/` live
outside this Evalo and are not subject to this Rule.

## Predicate language

Same status as the priority-order Rule (DECISIONS.md §13 #1): the predicate
above is prose for v0.1; once the predicate language is settled, it becomes a
formal expression. Until then, the runtime check uses a hard-coded scanner
and this Rule serves as documentation of the policy.
